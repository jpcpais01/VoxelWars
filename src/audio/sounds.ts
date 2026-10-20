import { BQ, Mode, Rng, Syn } from './dsp';

// Sound designs. Each entry renders one variant of a sound into a Float32Array (mono, or [L, R] for loops).
// `half` sounds are rendered at half the context rate: they are dark, long, or both.

export type Rendered = Float32Array | [Float32Array, Float32Array];
export interface SoundDef {
  variants: number;
  half?: boolean;
  gen: (rng: Rng, sr: number, v: number) => Rendered;
}

// ------------------------------------------------------------------------------------- guns

/** Per-gun voice: what the shot is made of at the shooter's position. */
export interface GunVoice {
  /** supersonic crack (N-wave) */
  crack: number;
  /** high sizzle after the crack */
  sizzle: number;
  sizzleDur: number;
  /** muzzle blast: low-passed broadband burst */
  blast: number;
  blastF: number;
  blastDur: number;
  /** body: band-passed noise that gives the gun its timbre */
  bodyF: number;
  bodyQ: number;
  bodyDur: number;
  body: number;
  /** punch: pitch-dropping saturated sine, the thump in the chest */
  punchF0: number;
  punchF1: number;
  punchDur: number;
  punch: number;
  drive: number;
  /** action noise: bolt carrier / hammer, struck metal partials */
  mech?: { modes: Mode[]; at: number; amp: number; ret?: number; retAmp?: number };
  /** barrel / frame ring */
  ring?: { modes: Mode[]; amp: number };
  /** close-range room tail inside the shot buffer */
  tail: number;
  tailDur: number;
  /** distant layer length and colour */
  far: number;
  farF: number;
  /** extra layers */
  extra?: (s: Syn, rng: Rng) => void;
  /** overall level at playback */
  gain: number;
  shell: 'brass' | 'big' | 'hull' | 'none';
  /** supersonic round: suppressed shots keep a soft crack, flybys snap */
  sonic: boolean;
}

const steel = (f: number, dec = 0.012): Mode[] => [
  [f, dec, 1],
  [f * 1.59, dec * 0.75, 0.7],
  [f * 2.41, dec * 0.5, 0.45],
  [f * 0.53, dec * 1.4, 0.4],
];

export const GUNS: Record<string, GunVoice> = {
  ar: {
    crack: 0.8, sizzle: 0.45, sizzleDur: 0.022,
    blast: 1, blastF: 6500, blastDur: 0.035,
    bodyF: 1000, bodyQ: 0.9, bodyDur: 0.17, body: 0.8,
    punchF0: 150, punchF1: 52, punchDur: 0.15, punch: 0.9, drive: 2.6,
    mech: { modes: steel(2300), at: 0.006, amp: 0.2, ret: 0.05, retAmp: 0.15 },
    tail: 0.26, tailDur: 0.5, far: 1.2, farF: 900,
    gain: 0.9, shell: 'brass', sonic: true,
  },
  smg: {
    crack: 0.22, sizzle: 0.35, sizzleDur: 0.014,
    blast: 0.9, blastF: 5200, blastDur: 0.022,
    bodyF: 1450, bodyQ: 1.1, bodyDur: 0.09, body: 0.85,
    punchF0: 185, punchF1: 78, punchDur: 0.085, punch: 0.62, drive: 2,
    mech: { modes: steel(3100, 0.009), at: 0.004, amp: 0.3, ret: 0.03, retAmp: 0.22 },
    tail: 0.18, tailDur: 0.32, far: 0.8, farF: 1100,
    gain: 0.78, shell: 'brass', sonic: false,
  },
  lmg: {
    crack: 1, sizzle: 0.55, sizzleDur: 0.026,
    blast: 1.1, blastF: 6000, blastDur: 0.04,
    bodyF: 800, bodyQ: 0.8, bodyDur: 0.21, body: 0.9,
    punchF0: 120, punchF1: 44, punchDur: 0.2, punch: 1, drive: 3,
    mech: { modes: steel(1500, 0.016), at: 0.007, amp: 0.3, ret: 0.05, retAmp: 0.26 },
    tail: 0.3, tailDur: 0.6, far: 1.5, farF: 800,
    extra: (s, rng) => s.ticks(0.02, 0.07, 4, 4800, 7200, 0.05 * rng.r(0.7, 1), 0.006), // belt links
    gain: 1, shell: 'brass', sonic: true,
  },
  shotgun: {
    crack: 0.3, sizzle: 0.4, sizzleDur: 0.02,
    blast: 1.2, blastF: 4500, blastDur: 0.055,
    bodyF: 560, bodyQ: 0.7, bodyDur: 0.32, body: 1,
    punchF0: 95, punchF1: 34, punchDur: 0.34, punch: 1.25, drive: 3.6,
    tail: 0.38, tailDur: 0.75, far: 1.8, farF: 700,
    gain: 1.05, shell: 'none', sonic: false,
  },
  sniper: {
    crack: 1.4, sizzle: 0.7, sizzleDur: 0.034,
    blast: 1.2, blastF: 7000, blastDur: 0.05,
    bodyF: 660, bodyQ: 0.75, bodyDur: 0.36, body: 0.95,
    punchF0: 90, punchF1: 31, punchDur: 0.42, punch: 1.3, drive: 3.6,
    ring: { modes: [[1150, 0.25, 1], [1720, 0.2, 0.7], [2890, 0.12, 0.4]], amp: 0.05 },
    tail: 0.42, tailDur: 1.05, far: 2.3, farF: 750,
    gain: 1.15, shell: 'none', sonic: true,
  },
  dmr: {
    crack: 1.15, sizzle: 0.6, sizzleDur: 0.028,
    blast: 1.1, blastF: 6500, blastDur: 0.042,
    bodyF: 760, bodyQ: 0.8, bodyDur: 0.27, body: 0.9,
    punchF0: 105, punchF1: 40, punchDur: 0.27, punch: 1.1, drive: 3,
    mech: { modes: steel(1900, 0.014), at: 0.006, amp: 0.26, ret: 0.06, retAmp: 0.2 },
    tail: 0.35, tailDur: 0.8, far: 1.8, farF: 800,
    gain: 1, shell: 'big', sonic: true,
  },
  revolver: {
    crack: 0.6, sizzle: 0.5, sizzleDur: 0.024,
    blast: 1.25, blastF: 5500, blastDur: 0.045,
    bodyF: 720, bodyQ: 0.9, bodyDur: 0.28, body: 1,
    punchF0: 125, punchF1: 45, punchDur: 0.27, punch: 1.15, drive: 3.2,
    ring: { modes: [[2600, 0.18, 1], [3910, 0.14, 0.6], [5450, 0.08, 0.35]], amp: 0.07 },
    mech: { modes: steel(3500, 0.008), at: 0.09, amp: 0.1 }, // cylinder indexes
    tail: 0.36, tailDur: 0.72, far: 1.5, farF: 850,
    extra: (s) => s.noise({ dur: 0.016, f0: 2600, q: 1.2, amp: 0.55 }), // cylinder-gap bark
    gain: 1.05, shell: 'none', sonic: true,
  },
  rocket: {
    crack: 0.3, sizzle: 0.2, sizzleDur: 0.02,
    blast: 1.1, blastF: 3000, blastDur: 0.12,
    bodyF: 420, bodyQ: 0.6, bodyDur: 0.42, body: 0.8,
    punchF0: 62, punchF1: 28, punchDur: 0.52, punch: 1.3, drive: 2.5,
    tail: 0.35, tailDur: 1.1, far: 2, farF: 600,
    extra: (s) => {
      // motor ignition roar and the backblast hiss
      s.noise({ at: 0.004, a: 0.012, dur: 0.95, f0: 2800, f1: 1100, q: 0.5, amp: 0.45, am: 0.5, amRate: 140 });
      s.noise({ at: 0.01, a: 0.02, dur: 0.6, f0: 380, type: 'lp', q: 0.6, amp: 0.5, am: 0.6, amRate: 90 });
    },
    gain: 1.1, shell: 'none', sonic: false,
  },
  gl: {
    crack: 0.08, sizzle: 0.15, sizzleDur: 0.012,
    blast: 0.7, blastF: 2500, blastDur: 0.04,
    bodyF: 300, bodyQ: 3, bodyDur: 0.11, body: 0.75,
    punchF0: 215, punchF1: 118, punchDur: 0.13, punch: 1, drive: 1.6,
    mech: { modes: steel(2800, 0.01), at: 0.12, amp: 0.16 },
    tail: 0.2, tailDur: 0.36, far: 1, farF: 700,
    extra: (s) => s.tone({ dur: 0.2, f0: 72, f1: 40, tau: 0.04, amp: 0.65, drive: 1.5 }), // the "thoonk" low end
    gain: 0.88, shell: 'none', sonic: false,
  },
  minigun: {
    crack: 0.6, sizzle: 0.45, sizzleDur: 0.012,
    blast: 0.9, blastF: 6000, blastDur: 0.016,
    bodyF: 1250, bodyQ: 1.2, bodyDur: 0.075, body: 0.75,
    punchF0: 155, punchF1: 66, punchDur: 0.075, punch: 0.7, drive: 2,
    tail: 0.14, tailDur: 0.24, far: 0.9, farF: 1000,
    gain: 0.74, shell: 'brass', sonic: true,
  },
};

function gunClose(g: GunVoice, rng: Rng, sr: number) {
  const s = new Syn(sr, Math.max(g.tailDur, g.punchDur, g.bodyDur) + 0.18, rng);
  const J = (v: number) => rng.j(v, 0.06);
  if (g.crack > 0.05) s.crack(0, g.crack, 0.0006 + rng.f() * 0.0002);
  s.noise({ dur: g.sizzleDur, f0: 4200, type: 'hp', amp: g.sizzle });
  s.noise({ dur: g.blastDur, f0: J(g.blastF), f1: 700, type: 'lp', amp: g.blast, curve: 0.7 });
  s.noise({ a: 0.0004, dur: g.bodyDur, f0: J(g.bodyF), f1: g.bodyF * 0.35, q: g.bodyQ, amp: g.body, curve: 0.8 });
  s.tone({ a: 0.0008, dur: g.punchDur, f0: J(g.punchF0), f1: g.punchF1, tau: g.punchDur * 0.18, amp: g.punch, drive: g.drive });
  if (g.ring) s.modal(0.001, g.ring.modes, g.ring.amp, 0.0005);
  g.extra?.(s, rng);
  s.noise({ at: 0.012, a: 0.006, dur: g.tailDur, f0: 900, f1: 160, type: 'lp', amp: g.tail, curve: 0.85 });
  // the ground bounce thickens the shot
  s.echo(0.0045 + rng.f() * 0.002, 0.35, 2600);
  s.drive(1.3);
  // the action is heard after the bang, unsaturated
  if (g.mech) {
    s.norm(1);
    s.modal(g.mech.at, g.mech.modes, g.mech.amp);
    if (g.mech.ret) s.modal(g.mech.ret + rng.f() * 0.006, g.mech.modes.map(([f, d, a]) => [f * 0.88, d, a] as Mode), g.mech.retAmp ?? g.mech.amp * 0.7);
  }
  return s.fade(0.03).norm(0.98).d;
}

function gunSuppressed(g: GunVoice, rng: Rng, sr: number) {
  const s = new Syn(sr, 0.5, rng);
  // gas through the baffles: a muffled "pfft" with very little low end
  s.noise({ a: 0.0008, dur: Math.min(0.1, g.bodyDur * 0.5 + 0.02), f0: rng.j(g.bodyF * 1.7), f1: g.bodyF * 0.6, q: 0.8, amp: 0.9, curve: 0.7 });
  s.noise({ a: 0.001, dur: 0.05, f0: 3000, f1: 1500, q: 0.6, amp: 0.4 });
  s.tone({ a: 0.0015, dur: g.punchDur * 0.45, f0: g.punchF0 * 1.3, f1: g.punchF1 * 1.6, tau: 0.01, amp: g.punch * 0.38, drive: 1.5 });
  // the bullet itself still breaks the sound barrier
  if (g.sonic) s.crack(0.0015, g.crack * 0.45, 0.0005);
  s.noise({ at: 0.01, a: 0.006, dur: 0.16, f0: 1200, f1: 300, type: 'lp', amp: 0.12 });
  s.drive(1.2).norm(1);
  // with the bang tamed, the action is front and centre
  if (g.mech) {
    s.modal(g.mech.at, g.mech.modes, Math.min(0.75, g.mech.amp * 2.6));
    if (g.mech.ret) s.modal(g.mech.ret, g.mech.modes.map(([f, d, a]) => [f * 0.88, d, a] as Mode), Math.min(0.6, (g.mech.retAmp ?? 0.2) * 2.6));
  } else s.modal(0.006, steel(2500, 0.012), 0.35);
  return s.fade(0.02).norm(0.98).d;
}

/** What the shot sounds like from far away: a low boom rolling back off the hills. */
function gunFar(g: GunVoice, rng: Rng, sr: number) {
  const s = new Syn(sr, g.far + 0.6, rng);
  s.noise({ a: 0.002, dur: 0.12, f0: g.farF * 1.8, f1: 400, type: 'lp', amp: 0.8, curve: 0.8 });
  s.tone({ a: 0.003, dur: g.punchDur * 1.6 + 0.08, f0: g.punchF0 * 0.75, f1: g.punchF1 * 0.8, tau: 0.03, amp: 0.7 * Math.min(1.2, g.punch), drive: 1.5 });
  s.noise({ at: 0.01, a: 0.01, dur: g.far * 0.75, f0: g.farF, f1: 120, type: 'lp', amp: 0.45, curve: 0.8, brown: true });
  // terrain echoes, each later one darker
  let t = 0.09 + rng.f() * 0.08;
  for (let i = 0; i < 5 && t < g.far; i++) {
    s.noise({ at: t, a: 0.012, dur: 0.18 + i * 0.08, f0: g.farF * (0.75 - i * 0.1), f1: 140, type: 'lp', amp: 0.42 * Math.pow(0.68, i), brown: true });
    t += 0.12 + rng.f() * 0.25 + i * 0.05;
  }
  return s.fade(0.1).norm(0.95).d;
}

// --------------------------------------------------------------------------------- foley

const clack = (s: Syn, at: number, f: number, amp: number, dec = 0.012) => s.modal(at, steel(f, dec), amp);
const slide = (s: Syn, at: number, dur: number, f0: number, f1: number, amp: number) =>
  s.noise({ at, a: dur * 0.3, dur, f0, f1, q: 1.2, amp, am: 0.5, amRate: 300 });

const FOLEY: Record<string, (s: Syn, rng: Rng) => void> = {
  magOut: (s, r) => {
    clack(s, 0, r.j(3800), 0.35, 0.006); // release button
    slide(s, 0.02, 0.12, 1800, 3200, 0.45);
    s.modal(0.13, steel(r.j(1400), 0.02), 0.4);
  },
  magIn: (s, r) => {
    slide(s, 0, 0.09, 2400, 1500, 0.35);
    s.modal(0.09, steel(r.j(1250), 0.022), 1);
    s.tone({ at: 0.09, dur: 0.06, f0: 220, f1: 120, tau: 0.01, amp: 0.4 });
    clack(s, 0.115, r.j(3300), 0.4, 0.008);
  },
  boltBack: (s, r) => {
    clack(s, 0, r.j(2600), 0.5, 0.008);
    slide(s, 0.01, 0.07, 2000, 4200, 0.45);
    clack(s, 0.075, r.j(2100), 0.7, 0.014);
  },
  boltFwd: (s, r) => {
    slide(s, 0, 0.04, 3600, 2000, 0.35);
    s.modal(0.045, steel(r.j(1700), 0.022), 1);
    s.tone({ at: 0.045, dur: 0.05, f0: 260, f1: 150, tau: 0.01, amp: 0.3 });
  },
  boltUp: (s, r) => clack(s, 0, r.j(3000), 0.6, 0.01),
  boltDown: (s, r) => {
    clack(s, 0, r.j(2200), 0.8, 0.014);
    clack(s, 0.012, r.j(4000), 0.3, 0.006);
  },
  pumpBack: (s, r) => {
    slide(s, 0, 0.08, 1300, 2600, 0.6);
    s.modal(0.085, steel(r.j(1100), 0.02), 1);
    s.tone({ at: 0.085, dur: 0.06, f0: 180, f1: 110, tau: 0.01, amp: 0.4 });
  },
  pumpFwd: (s, r) => {
    slide(s, 0, 0.07, 2400, 1200, 0.5);
    s.modal(0.075, steel(r.j(1450), 0.024), 1);
    clack(s, 0.088, r.j(3200), 0.35, 0.008);
  },
  shellIn: (s, r) => {
    s.noise({ dur: 0.05, a: 0.01, f0: 900, q: 1.5, amp: 0.4 }); // plastic hull scrapes in
    s.modal(0.045, [[r.j(1900), 0.012, 1], [r.j(3100), 0.008, 0.6], [r.j(720), 0.018, 0.5]], 0.9);
  },
  cylOpen: (s, r) => {
    clack(s, 0, r.j(3400), 0.6, 0.008);
    slide(s, 0.01, 0.06, 2500, 1800, 0.3);
    s.modal(0.07, steel(r.j(1800), 0.02), 0.7);
  },
  cylClose: (s, r) => {
    s.modal(0, steel(r.j(1600), 0.025), 1);
    s.ticks(0.02, 0.12, 5, 4200, 5600, 0.12, 0.005); // cylinder spins
  },
  hammer: (s, r) => {
    clack(s, 0, r.j(2900), 0.6, 0.008);
    clack(s, 0.03, r.j(3600), 0.8, 0.01);
  },
  ejectShells: (s) => {
    s.noise({ dur: 0.04, f0: 2000, q: 1, amp: 0.4 });
    s.ticks(0.05, 0.45, 12, 3800, 7200, 0.35, 0.03, 1.6);
  },
  speedloader: (s, r) => {
    slide(s, 0, 0.06, 2200, 1500, 0.35);
    s.modal(0.06, steel(r.j(2000), 0.018), 0.9);
    s.ticks(0.065, 0.08, 4, 3500, 5000, 0.2, 0.008);
  },
  coverOpen: (s, r) => {
    clack(s, 0, r.j(2200), 0.6, 0.01);
    s.noise({ at: 0.01, dur: 0.08, f0: 900, f1: 2500, q: 0.8, amp: 0.25 });
    s.modal(0.09, steel(r.j(900), 0.03), 0.6);
  },
  coverSlam: (s, r) => {
    s.modal(0, steel(r.j(850), 0.035), 1);
    s.tone({ dur: 0.08, f0: 160, f1: 90, tau: 0.015, amp: 0.5 });
    clack(s, 0.015, r.j(2600), 0.4, 0.01);
  },
  beltRattle: (s) => s.ticks(0, 0.32, 18, 3000, 6500, 0.4, 0.01),
  boxClunk: (s, r) => {
    s.tone({ dur: 0.12, f0: 140, f1: 70, tau: 0.02, amp: 0.8, drive: 1.5 });
    s.modal(0.002, steel(r.j(700), 0.04), 0.8);
    s.ticks(0.01, 0.15, 8, 3000, 6000, 0.25, 0.01);
  },
  tubeLoad: (s, r) => {
    s.noise({ dur: 0.32, a: 0.12, f0: 700, f1: 1400, q: 1.6, amp: 0.4, am: 0.4, amRate: 200 });
    s.modal(0.32, steel(r.j(950), 0.03), 0.9);
    s.tone({ at: 0.32, dur: 0.1, f0: 140, f1: 80, tau: 0.02, amp: 0.5 });
  },
  latch: (s, r) => {
    clack(s, 0, r.j(2400), 0.8, 0.012);
    clack(s, 0.018, r.j(3600), 0.5, 0.008);
  },
  breachOpen: (s, r) => {
    clack(s, 0, r.j(2000), 0.7, 0.014);
    s.noise({ at: 0.01, dur: 0.12, f0: 600, q: 1.5, amp: 0.3 });
  },
  shellOut: (s, r) => {
    s.modal(0, [[r.j(1200), 0.03, 1], [r.j(2700), 0.02, 0.5]], 0.6);
    s.tone({ at: 0.18, dur: 0.06, f0: 180, f1: 120, amp: 0.4 });
  },
  motorBlip: (s) => {
    s.tone({ a: 0.03, dur: 0.35, f0: 180, f1: 520, wave: 'saw', amp: 0.4, lp: 1800 });
    s.ticks(0.02, 0.3, 10, 2000, 3500, 0.2, 0.008);
  },
  draw: (s, r) => {
    s.noise({ a: 0.05, dur: 0.18, f0: 1500, f1: 3000, q: 0.6, amp: 0.35, am: 0.6, amRate: 120 }); // cloth
    clack(s, 0.18, r.j(2600), 0.6, 0.01);
    clack(s, 0.22, r.j(3400), 0.35, 0.007);
  },
  ads: (s) => s.noise({ a: 0.04, dur: 0.12, f0: 1200, f1: 2600, q: 0.5, amp: 1, am: 0.7, amRate: 160 }),
  dry: (s, r) => {
    clack(s, 0, r.j(2200), 1, 0.01);
    s.tone({ dur: 0.03, f0: 420, f1: 300, amp: 0.3 });
  },
  boltLock: (s, r) => {
    s.modal(0, steel(r.j(1600), 0.03), 1);
    s.modal(0.004, [[r.j(5200), 0.12, 1], [r.j(7300), 0.08, 0.5]], 0.25); // the empty mag pings
  },
  lowAmmo: (s, r) => s.modal(0, [[r.j(4800), 0.06, 1], [r.j(7100), 0.04, 0.5], [r.j(2900), 0.03, 0.4]], 1, 0.0005),
  brass: (s, r) => {
    // a casing hits the ground, bounces and rolls
    let t = 0, a = 1;
    const f = r.r(3800, 5200);
    for (let i = 0; i < 4; i++) {
      s.modal(t, [[f * r.r(0.98, 1.02), 0.06, 1], [f * 2.72, 0.04, 0.6], [f * 0.6, 0.03, 0.3]], a * 0.8, 0.0005);
      t += 0.06 * Math.pow(0.62, i) + r.f() * 0.02;
      a *= 0.5;
    }
  },
  bigBrass: (s, r) => {
    let t = 0, a = 1;
    const f = r.r(2800, 3600);
    for (let i = 0; i < 4; i++) {
      s.modal(t, [[f, 0.08, 1], [f * 2.4, 0.05, 0.5], [f * 0.55, 0.04, 0.35]], a * 0.8, 0.0005);
      t += 0.075 * Math.pow(0.6, i) + r.f() * 0.02;
      a *= 0.5;
    }
  },
  hull: (s, r) => {
    // a plastic shotgun hull: dull bounces
    let t = 0, a = 1;
    for (let i = 0; i < 3; i++) {
      s.modal(t, [[r.r(900, 1200), 0.015, 1], [r.r(2000, 2600), 0.01, 0.5]], a * 0.7, 0.0008);
      t += 0.07 * Math.pow(0.6, i);
      a *= 0.45;
    }
  },
  pin: (s, r) => {
    clack(s, 0, r.j(3000), 0.5, 0.008);
    s.modal(0.03, [[r.j(3900), 0.25, 1], [r.j(6100), 0.15, 0.4]], 0.5); // ring of the pin
    s.modal(0.12, [[r.j(2600), 0.2, 1], [r.j(4400), 0.12, 0.5]], 0.6); // spoon flies off
  },
  throw: (s) => s.noise({ a: 0.1, dur: 0.14, f0: 500, f1: 2600, q: 0.7, amp: 1 }),
  bounce: (s, r) => {
    s.tone({ dur: 0.05, f0: 180, f1: 90, tau: 0.01, amp: 0.7 });
    s.modal(0, [[r.j(1300), 0.05, 1], [r.j(2100), 0.04, 0.6], [r.j(3700), 0.02, 0.4]], 0.8);
  },
  stick: (s, r) => {
    s.noise({ dur: 0.05, f0: 500, type: 'lp', amp: 0.8 });
    s.modal(0.002, [[r.j(800), 0.03, 1], [r.j(1500), 0.02, 0.4]], 0.5);
  },
  beep: (s) => {
    s.tone({ dur: 0.07, hold: 0.04, a: 0.002, f0: 2700, amp: 0.7 });
    s.tone({ dur: 0.07, hold: 0.04, a: 0.002, f0: 5400, amp: 0.18 });
  },
  detonator: (s, r) => {
    clack(s, 0, r.j(2500), 0.7, 0.01);
    clack(s, 0.07, r.j(2900), 0.8, 0.01);
    s.tone({ at: 0.1, dur: 0.1, hold: 0.05, a: 0.002, f0: 3200, amp: 0.4 });
  },
  medkit: (s) => {
    // velcro rip, then the injector hiss
    s.noise({ dur: 0.3, hold: 0.2, a: 0.01, f0: 2600, q: 0.7, amp: 0.8, am: 1, amRate: 900, curve: 3 });
    s.noise({ at: 0.45, a: 0.03, dur: 0.5, f0: 6000, type: 'hp', amp: 0.35, curve: 1.5 });
    s.modal(0.43, steel(3000, 0.01), 0.4);
  },
};

// -------------------------------------------------------------------------------- impacts

const IMPACT: Record<string, (s: Syn, r: Rng) => void> = {
  ground: (s, r) => {
    s.tone({ dur: 0.06, f0: r.r(170, 220), f1: 70, tau: 0.01, amp: 0.7 });
    s.noise({ dur: 0.08, f0: r.r(1200, 1800), f1: 400, type: 'lp', amp: 0.8 });
    s.noise({ at: 0.02, dur: 0.18, a: 0.02, f0: 3500, type: 'hp', amp: 0.2, am: 0.9, amRate: 500 }); // dirt spray
  },
  stone: (s, r) => {
    s.crack(0, 0.6, 0.0003);
    s.noise({ dur: 0.04, f0: r.r(2600, 3600), f1: 1500, q: 0.9, amp: 1 });
    s.modal(0.001, [[r.r(1600, 2200), 0.02, 1], [r.r(3100, 3900), 0.012, 0.6]], 0.4);
    s.ticks(0.02, 0.2, 5, 2500, 5500, 0.25, 0.01, 1.5); // chips
  },
  build: (s, r) => {
    s.crack(0, 0.5, 0.0004);
    s.noise({ dur: 0.07, f0: r.r(1600, 2200), f1: 700, q: 0.8, amp: 1 });
    s.noise({ at: 0.015, a: 0.01, dur: 0.22, f0: 1800, type: 'lp', amp: 0.3, am: 0.8, amRate: 300 }); // crumble
    s.ticks(0.03, 0.25, 4, 1500, 3500, 0.25, 0.012, 1.5);
  },
  wood: (s, r) => {
    s.modal(0, [[r.r(380, 520), 0.05, 1], [r.r(900, 1150), 0.03, 0.6], [r.r(1900, 2300), 0.015, 0.35]], 1, 0.001, 1500);
    s.noise({ dur: 0.05, f0: 1800, q: 1, amp: 0.4 });
    s.ticks(0.01, 0.12, 4, 2000, 4500, 0.2, 0.006); // splinters
  },
  leaf: (s) => {
    s.noise({ a: 0.008, dur: 0.18, f0: 5000, f1: 2500, q: 0.5, amp: 1, am: 0.9, amRate: 400 });
    s.ticks(0.01, 0.1, 3, 1500, 2500, 0.3, 0.008); // a twig
  },
  metal: (s, r) => {
    const f = r.r(1700, 2600);
    s.modal(0, [[f, 0.4, 1], [f * 1.47, 0.3, 0.8], [f * 2.09, 0.22, 0.6], [f * 2.83, 0.15, 0.4], [f * 0.61, 0.25, 0.4]], 1, 0.001, 3000);
    s.crack(0, 0.6, 0.0003);
  },
  soft: (s, r) => {
    s.tone({ dur: 0.07, f0: r.r(140, 190), f1: 70, tau: 0.01, amp: 0.8 });
    s.noise({ dur: 0.07, f0: 700, type: 'lp', amp: 0.8 });
    s.noise({ at: 0.01, dur: 0.12, f0: 2500, q: 0.5, amp: 0.15, am: 0.8, amRate: 300 });
  },
  water: (s, r) => {
    s.tone({ a: 0.003, dur: 0.06, f0: r.r(500, 700), f1: r.r(1300, 1700), amp: 0.5 });
    s.noise({ a: 0.004, dur: 0.18, f0: 2200, f1: 900, q: 0.8, amp: 1, am: 0.6, amRate: 200 });
  },
  flesh: (s, r) => {
    s.tone({ dur: 0.08, f0: r.r(180, 230), f1: 70, tau: 0.012, amp: 1, drive: 1.5 });
    s.noise({ dur: 0.07, f0: r.r(700, 950), f1: 300, q: 1, amp: 0.8 });
    s.noise({ at: 0.005, dur: 0.05, f0: 2500, q: 0.8, amp: 0.25 });
  },
  ric: (s, r) => {
    // ricochet whine
    const f = r.r(2800, 4200);
    s.tone({ a: 0.004, dur: r.r(0.25, 0.4), f0: f, f1: f * r.r(0.3, 0.5), vib: 0.03, vibF: r.r(25, 45), amp: 0.7, curve: 1.4 });
    s.noise({ a: 0.01, dur: 0.25, f0: f * 0.8, f1: f * 0.4, q: 4, amp: 0.4 });
  },
};

// ------------------------------------------------------------------------------ footsteps

const STEP: Record<string, (s: Syn, r: Rng) => void> = {
  grass: (s, r) => {
    s.tone({ dur: 0.05, f0: r.r(90, 120), f1: 55, tau: 0.01, amp: 0.4 });
    s.noise({ a: 0.01, dur: 0.12, f0: r.r(2500, 3500), q: 0.5, amp: 1, am: 0.8, amRate: 600 });
    s.noise({ at: 0.06, a: 0.01, dur: 0.08, f0: 4000, q: 0.6, amp: 0.4, am: 0.8, amRate: 600 });
  },
  dirt: (s, r) => {
    s.tone({ dur: 0.05, f0: r.r(100, 140), f1: 60, tau: 0.01, amp: 0.7 });
    s.noise({ dur: 0.07, f0: r.r(700, 1000), f1: 400, type: 'lp', amp: 0.9 });
    s.noise({ at: 0.03, a: 0.01, dur: 0.07, f0: 2200, q: 0.7, amp: 0.3, am: 0.8, amRate: 500 });
  },
  gravel: (s, r) => {
    s.tone({ dur: 0.04, f0: r.r(110, 140), f1: 60, tau: 0.01, amp: 0.5 });
    s.noise({ a: 0.01, dur: 0.12, f0: 2500, q: 0.6, amp: 0.5, am: 1, amRate: 900 });
    s.ticks(0, 0.13, 14, 1800, 5000, 0.6, 0.008);
  },
  sand: (s, r) => {
    s.tone({ dur: 0.05, f0: r.r(90, 110), f1: 55, tau: 0.012, amp: 0.4 });
    s.noise({ a: 0.02, dur: 0.14, f0: r.r(1600, 2400), q: 0.4, amp: 1, curve: 1.3 });
  },
  stone: (s, r) => {
    s.tone({ dur: 0.035, f0: r.r(150, 190), f1: 80, tau: 0.008, amp: 0.6 });
    s.noise({ dur: 0.03, f0: r.r(2200, 3000), q: 0.8, amp: 0.8 });
    s.noise({ at: 0.035, dur: 0.04, f0: 3500, q: 0.8, amp: 0.35 }); // toe
  },
  wood: (s, r) => {
    s.modal(0, [[r.r(160, 210), 0.06, 1], [r.r(420, 520), 0.04, 0.6], [r.r(900, 1100), 0.02, 0.3]], 1, 0.002, 1200);
    s.noise({ dur: 0.03, f0: 1500, q: 0.8, amp: 0.3 });
    if (r.f() < 0.5) s.tone({ at: 0.02, a: 0.03, dur: 0.12, f0: r.r(300, 420), f1: r.r(250, 330), wave: 'saw', amp: 0.08, lp: 900 }); // creak
  },
  metal: (s, r) => {
    const f = r.r(500, 700);
    s.modal(0, [[f, 0.12, 1], [f * 1.7, 0.09, 0.7], [f * 2.6, 0.06, 0.5], [f * 4.1, 0.03, 0.3]], 1, 0.002, 1500);
    s.tone({ dur: 0.04, f0: 140, f1: 80, tau: 0.01, amp: 0.5 });
  },
  water: (s, r) => {
    s.noise({ a: 0.03, dur: 0.25, f0: r.r(700, 1000), f1: 1800, q: 0.9, amp: 1, am: 0.5, amRate: 200 });
    s.noise({ at: 0.1, a: 0.02, dur: 0.2, f0: 2600, q: 0.7, amp: 0.4, am: 0.8, amRate: 300 });
    s.tone({ at: 0.05, a: 0.004, dur: 0.04, f0: r.r(600, 800), f1: 1500, amp: 0.15 });
  },
  gear: (s) => {
    // webbing, mag pouches and buckles rattling on the run
    s.noise({ a: 0.02, dur: 0.1, f0: 1800, q: 0.6, amp: 0.6, am: 0.8, amRate: 300 });
    s.ticks(0.01, 0.1, 4, 2500, 4500, 0.5, 0.01);
  },
};

// ----------------------------------------------------------------------------- explosions

function boomClose(rng: Rng, sr: number, size: number) {
  const L = [1.4, 2.6, 3.6][size];
  const s = new Syn(sr, L, rng);
  s.crack(0, 1, 0.0008 + size * 0.0005);
  s.noise({ dur: 0.18 + size * 0.15, f0: 9000, f1: 300, type: 'lp', amp: 1.2, curve: 0.6 });
  s.tone({ a: 0.002, dur: 0.55 + size * 0.4, f0: rng.j(80 - size * 8), f1: 22, tau: 0.06 + size * 0.03, amp: 1.5, drive: 4 });
  s.noise({ a: 0.004, dur: 0.8 + size * 0.6, f0: 1800, f1: 80, type: 'lp', amp: 0.9, curve: 0.75, brown: true });
  s.noise({ at: 0.02, a: 0.03, dur: 0.4 + size * 0.35, f0: 900, f1: 380, q: 0.5, amp: 0.45, am: 0.85, amRate: 70 }); // fireball crackle
  s.drive(1.6).norm(1);
  // debris rains down: dirt, wood and stone chunks
  s.ticks(0.18, 0.6 + size * 0.7, 10 + size * 14, 500, 3200, 0.07, 0.02, 1.8);
  s.noise({ at: 0.25, a: 0.25, dur: 0.6 + size * 0.5, f0: 3000, type: 'hp', amp: 0.05 + size * 0.02, am: 1, amRate: 400 }); // dirt patter
  s.noise({ at: 0.08, a: 0.1, dur: 1 + size * 0.9, f0: 280, type: 'lp', amp: 0.35, brown: true }); // rumble
  return s.fade(0.2).norm(0.98).d;
}

function boomFar(rng: Rng, sr: number, size: number) {
  const s = new Syn(sr, 2.6 + size * 1.2, rng);
  s.tone({ a: 0.008, dur: 0.6 + size * 0.4, f0: 60, f1: 22, tau: 0.08, amp: 1, drive: 2.5 });
  s.noise({ a: 0.005, dur: 0.9 + size * 0.5, f0: 900, f1: 70, type: 'lp', amp: 0.9, brown: true, curve: 0.8 });
  // thunder-like roll off the valley walls
  let t = 0.15 + rng.f() * 0.1;
  for (let i = 0; i < 6; i++) {
    s.noise({ at: t, a: 0.05, dur: 0.4 + i * 0.12, f0: 500 - i * 50, f1: 60, type: 'lp', amp: 0.5 * Math.pow(0.72, i), brown: true });
    t += 0.18 + rng.f() * 0.3;
  }
  return s.fade(0.3).norm(0.95).d;
}

// ------------------------------------------------------------------------------- ambience

function riverLoop(rng: Rng, sr: number): Rendered {
  const mk = () => {
    const s = new Syn(sr, 6.5, rng);
    s.noise({ dur: 7, hold: 6.5, f0: 1400, type: 'lp', amp: 0.4, a: 0.01, brown: true });
    // babbling: narrow bands whose centres wander
    for (let k = 0; k < 4; k++) {
      let t = 0;
      while (t < 6.4) {
        const d = rng.r(0.15, 0.5);
        s.noise({ at: t, a: d * 0.4, dur: d, f0: rng.r(350, 2600), f1: rng.r(350, 2600), q: rng.r(2, 6), amp: rng.r(0.08, 0.2), curve: 1.5 });
        t += d * rng.r(0.5, 0.9);
      }
    }
    // bubbles
    for (let i = 0; i < 70; i++) {
      const f = rng.r(500, 1500);
      s.tone({ at: rng.r(0, 6.4), a: 0.004, dur: rng.r(0.015, 0.04), f0: f, f1: f * rng.r(1.6, 2.4), amp: rng.r(0.03, 0.09) });
    }
    return s.norm(0.9).loop(0.5);
  };
  return [mk(), mk()];
}

function windLoop(rng: Rng, sr: number): Rendered {
  const mk = () => {
    const s = new Syn(sr, 9, rng);
    s.noise({ dur: 9, hold: 9, a: 0.01, f0: 420, type: 'lp', q: 0.5, amp: 0.5, brown: true, steep: true });
    // gusts
    let t = 0;
    while (t < 8.8) {
      const d = rng.r(1.2, 3);
      s.noise({ at: t, a: d * 0.45, dur: d, f0: rng.r(250, 600), q: rng.r(1.5, 3), amp: rng.r(0.15, 0.35), curve: 1.6 });
      t += d * rng.r(0.4, 0.7);
    }
    return s.norm(0.9).loop(0.8);
  };
  return [mk(), mk()];
}

function leavesLoop(rng: Rng, sr: number): Rendered {
  const mk = () => {
    const s = new Syn(sr, 7, rng);
    let t = 0;
    while (t < 6.9) {
      const d = rng.r(0.4, 1.4);
      s.noise({ at: t, a: d * 0.4, dur: d, f0: rng.r(3000, 6500), q: 0.6, amp: rng.r(0.25, 0.6), am: 0.95, amRate: 260, curve: 1.4 });
      t += d * rng.r(0.25, 0.6);
    }
    return s.norm(0.9).loop(0.6);
  };
  return [mk(), mk()];
}

function insectsLoop(rng: Rng, sr: number): Rendered {
  const mk = () => {
    const s = new Syn(sr, 5.5, rng);
    for (let c = 0; c < 3; c++) {
      const f = rng.r(4200, 5600);
      const amp = rng.r(0.3, 1);
      let t = rng.r(0, 0.8);
      while (t < 5.2) {
        const n = 2 + ((rng.f() * 3) | 0);
        for (let i = 0; i < n; i++) s.tone({ at: t + i * 0.035, a: 0.004, dur: 0.018, f0: f, amp: amp * 0.5 });
        t += rng.r(0.5, 1.1);
      }
    }
    return s.norm(0.9).loop(0.3);
  };
  return [mk(), mk()];
}

const BIRDS: ((s: Syn, r: Rng) => void)[] = [
  // trill
  (s, r) => {
    const f = r.r(3400, 4600), n = 10 + ((r.f() * 10) | 0);
    for (let i = 0; i < n; i++) s.tone({ at: i * 0.045, a: 0.004, dur: 0.035, f0: f * 1.1, f1: f * 0.85, amp: 0.6 + 0.4 * Math.sin((i / n) * Math.PI) });
  },
  // slurred whistle
  (s, r) => {
    const f = r.r(2000, 2700);
    s.tone({ a: 0.03, dur: 0.28, f0: f, f1: f * 1.35, amp: 1, vib: 0.01, vibF: 30 });
    s.tone({ at: 0.32, a: 0.02, dur: 0.22, f0: f * 1.2, f1: f * 0.95, amp: 0.8 });
  },
  // warbler song
  (s, r) => {
    let t = 0;
    for (let i = 0; i < 9; i++) {
      const d = r.r(0.05, 0.1);
      s.tone({ at: t, a: 0.006, dur: d, f0: r.r(2600, 5200), f1: r.r(2600, 5200), amp: r.r(0.5, 1) });
      t += d + r.r(0.01, 0.04);
    }
  },
  // "fee-bee"
  (s, r) => {
    const f = r.r(3600, 4100);
    s.tone({ a: 0.02, dur: 0.3, hold: 0.1, f0: f, amp: 1, curve: 2 });
    s.tone({ at: 0.45, a: 0.02, dur: 0.3, hold: 0.1, f0: f * 0.84, amp: 0.85, curve: 2 });
  },
  // wood pigeon coo
  (s, r) => {
    const f = r.r(480, 600);
    const pat = [0, 0.35, 0.9, 1.25];
    pat.forEach((t, i) => s.tone({ at: t, a: 0.05, dur: 0.28, f0: f * (i === 1 ? 1.08 : 1), f1: f * 0.94, amp: i === 1 ? 1 : 0.7, wave: 'tri', lp: 900 }));
  },
  // woodpecker drumming, far away
  (s, r) => {
    const n = 12 + ((r.f() * 8) | 0);
    let t = 0;
    for (let i = 0; i < n; i++) {
      s.modal(t, [[r.j(950, 0.02), 0.03, 1], [r.j(1650, 0.02), 0.02, 0.5]], 1 - i / (n * 1.4), 0.001, 1000);
      t += 0.052 + i * 0.0015;
    }
  },
  // crow
  (s, r) => {
    const n = 2 + ((r.f() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const at = i * 0.42;
      s.tone({ at, a: 0.02, dur: 0.22, hold: 0.06, f0: r.r(560, 680), f1: r.r(480, 560), wave: 'saw', amp: 1, lp: 2400, vib: 0.04, vibF: 55 });
      s.noise({ at, a: 0.02, dur: 0.2, hold: 0.06, f0: 1300, q: 2, amp: 0.4 });
    }
  },
  // sparrow chirps
  (s, r) => {
    let t = 0;
    for (let i = 0; i < 4 + ((r.f() * 4) | 0); i++) {
      s.tone({ at: t, a: 0.003, dur: 0.05, f0: r.r(4800, 6200), f1: r.r(2800, 3600), amp: r.r(0.6, 1) });
      t += r.r(0.09, 0.2);
    }
  },
];

// -------------------------------------------------------------------------------------- UI

const UI: Record<string, (s: Syn, r: Rng) => void> = {
  click: (s) => {
    s.modal(0, [[1850, 0.05, 1], [2780, 0.03, 0.5], [5400, 0.012, 0.3]], 1, 0.0006, 3000);
    s.tone({ dur: 0.03, f0: 600, f1: 300, amp: 0.25 });
  },
  hover: (s) => s.modal(0, [[3600, 0.018, 1], [5200, 0.01, 0.5]], 1, 0.0004, 4000),
  deploy: (s) => {
    s.noise({ a: 0.35, dur: 0.25, f0: 300, f1: 3000, q: 0.8, amp: 0.6, curve: 1.5 });
    s.tone({ at: 0.36, dur: 0.5, f0: 110, f1: 45, tau: 0.06, amp: 1, drive: 2.5 });
    s.noise({ at: 0.36, dur: 0.5, f0: 1200, type: 'lp', amp: 0.4, brown: true });
    [880, 1320, 1760].forEach((f, i) => s.tone({ at: 0.36 + i * 0.03, a: 0.01, dur: 0.6, f0: f, amp: 0.12 }));
  },
  hit: (s) => {
    s.noise({ dur: 0.008, f0: 5000, type: 'hp', amp: 0.6 });
    s.modal(0, [[2950, 0.04, 1], [4400, 0.025, 0.4]], 0.9, 0.0004, 4000);
    s.tone({ dur: 0.04, f0: 220, f1: 120, tau: 0.008, amp: 0.4 });
  },
  head: (s) => {
    s.noise({ dur: 0.008, f0: 5000, type: 'hp', amp: 0.6 });
    s.modal(0, [[2380, 0.32, 1], [3680, 0.24, 0.7], [5920, 0.14, 0.45], [8100, 0.06, 0.2]], 1, 0.0004, 3500); // helmet "dink"
    s.tone({ dur: 0.05, f0: 240, f1: 120, tau: 0.008, amp: 0.4 });
  },
  kill: (s) => {
    s.tone({ dur: 0.16, f0: 170, f1: 70, tau: 0.02, amp: 1, drive: 2 });
    s.noise({ dur: 0.01, f0: 5000, type: 'hp', amp: 0.5 });
    s.modal(0, [[2100, 0.06, 1], [3150, 0.04, 0.5]], 0.6, 0.0004);
    s.tone({ at: 0.05, a: 0.004, dur: 0.22, f0: 1318.5, amp: 0.28 });
    s.tone({ at: 0.11, a: 0.004, dur: 0.38, f0: 1975.5, amp: 0.3 });
  },
  streak: (s) => {
    [880, 1108.7, 1318.5, 1760].forEach((f, i) => {
      s.tone({ at: i * 0.055, a: 0.006, dur: 0.7, f0: f, amp: 0.4 });
      s.tone({ at: i * 0.055, a: 0.006, dur: 0.4, f0: f * 2.01, amp: 0.1 });
    });
    s.noise({ a: 0.05, dur: 0.6, f0: 7000, type: 'hp', amp: 0.08 });
  },
  alarm: (s) => {
    for (let i = 0; i < 3; i++) {
      s.tone({ at: i * 0.3, a: 0.01, dur: 0.12, hold: 0.1, f0: 740, wave: 'saw', amp: 0.8, lp: 2200, curve: 2 });
      s.tone({ at: i * 0.3 + 0.15, a: 0.01, dur: 0.12, hold: 0.06, f0: 554, wave: 'saw', amp: 0.8, lp: 2200, curve: 2 });
    }
  },
  win: (s) => chordStinger(s, [261.6, 329.6, 392, 523.3], [523.3, 659.3, 784, 1046.5], true),
  lose: (s) => chordStinger(s, [220, 261.6, 329.6, 207.7], [164.8, 196, 246.9, 329.6], false),
  hurt: (s, r) => {
    s.tone({ dur: 0.14, f0: r.r(120, 150), f1: 45, tau: 0.02, amp: 1, drive: 2.5 });
    s.noise({ dur: 0.08, f0: 700, f1: 250, q: 0.9, amp: 0.7 });
    s.noise({ dur: 0.012, f0: 4000, type: 'hp', amp: 0.35 });
  },
  death: (s) => {
    s.tone({ dur: 1.2, f0: 90, f1: 28, tau: 0.12, amp: 1, drive: 3 });
    s.noise({ dur: 0.9, f0: 600, f1: 60, type: 'lp', amp: 0.6, brown: true });
    s.tone({ at: 0.05, a: 0.3, dur: 1.8, f0: 3600, amp: 0.12 });
  },
  heart: (s) => {
    s.tone({ dur: 0.12, f0: 70, f1: 42, tau: 0.03, amp: 1, drive: 1.5 });
    s.tone({ at: 0.16, dur: 0.14, f0: 60, f1: 38, tau: 0.03, amp: 0.75, drive: 1.5 });
  },
  ring: (s) => {
    s.tone({ a: 0.05, dur: 2.6, f0: 3550, amp: 1, curve: 1.3 });
    s.tone({ a: 0.05, dur: 2.2, f0: 3590, amp: 0.6, curve: 1.3 });
  },
  snap: (s) => {
    // a supersonic round passing your head
    s.crack(0, 1, 0.0004);
    s.noise({ dur: 0.012, f0: 5000, type: 'hp', amp: 0.5 });
    s.noise({ at: 0.003, a: 0.004, dur: 0.06, f0: 3000, f1: 1500, q: 1.2, amp: 0.25 });
  },
  whiz: (s, r) => {
    const f = r.r(2400, 3400);
    s.noise({ a: 0.05, dur: 0.12, f0: f, f1: f * 0.35, q: 2.2, amp: 1, curve: 1.2 });
    s.tone({ a: 0.05, dur: 0.11, f0: f * 0.9, f1: f * 0.5, amp: 0.1 });
  },
  flap: (s, r) => {
    // birds bursting out of the trees
    const n = 10 + ((r.f() * 6) | 0);
    for (let i = 0; i < n; i++) s.noise({ at: i * r.r(0.07, 0.09), a: 0.015, dur: 0.05, f0: r.r(700, 1300), q: 0.8, amp: 1 - (i / n) * 0.6 });
  },
  smoke: (s) => {
    s.tone({ dur: 0.06, f0: 300, f1: 140, tau: 0.01, amp: 0.6 });
    s.noise({ dur: 0.04, f0: 2000, type: 'lp', amp: 0.7 });
    s.noise({ at: 0.04, a: 0.15, dur: 2.2, hold: 0.6, f0: 4500, q: 0.4, amp: 0.45, am: 0.25, amRate: 60 });
  },
  creakTree: (s, r) => {
    // trunk fibres giving way, then the crown rushing down
    let t = 0;
    for (let i = 0; i < 6; i++) {
      const d = r.r(0.12, 0.3);
      s.tone({ at: t, a: d * 0.3, dur: d, f0: r.r(90, 170), f1: r.r(70, 150), wave: 'saw', amp: r.r(0.4, 0.7), lp: 900, vib: 0.03, vibF: r.r(8, 16) });
      t += d * r.r(0.6, 1);
    }
    s.ticks(0, t, 14, 1200, 3800, 0.6, 0.01, 0.6);
    s.crack(t, 0.7, 0.001);
    s.noise({ at: t, dur: 0.15, f0: 2000, q: 0.8, amp: 0.8 });
    s.noise({ at: t * 0.6, a: 0.8, dur: 0.8, f0: 3500, q: 0.4, amp: 0.45, am: 0.8, amRate: 300 });
  },
  creakBuild: (s) => {
    s.noise({ a: 0.2, dur: 0.9, f0: 500, type: 'lp', amp: 0.8, am: 0.8, amRate: 60, brown: true });
    s.ticks(0, 0.9, 16, 600, 2600, 0.5, 0.015, 0.7);
    s.tone({ a: 0.2, dur: 0.6, f0: 120, f1: 80, wave: 'saw', amp: 0.25, lp: 500 });
  },
  crashTree: (s) => {
    s.tone({ dur: 0.5, f0: 75, f1: 30, tau: 0.05, amp: 1, drive: 2.5 });
    s.noise({ dur: 0.5, f0: 900, type: 'lp', amp: 0.8, brown: true });
    s.noise({ a: 0.02, dur: 1.1, f0: 4200, q: 0.4, amp: 0.6, am: 0.9, amRate: 350 }); // leaves crash
    s.ticks(0.02, 0.7, 14, 900, 3500, 0.45, 0.012, 1.4); // branches snap
  },
  crashRubble: (s) => {
    s.tone({ dur: 0.6, f0: 70, f1: 26, tau: 0.06, amp: 1, drive: 3 });
    s.noise({ dur: 1.1, f0: 1100, f1: 120, type: 'lp', amp: 0.9, brown: true, am: 0.4, amRate: 50 });
    s.ticks(0.03, 1.2, 30, 500, 3000, 0.4, 0.02, 1.5);
    s.noise({ at: 0.1, a: 0.1, dur: 0.9, f0: 3500, type: 'hp', amp: 0.12, am: 1, amRate: 400 });
  },
  splashBig: (s, r) => {
    s.tone({ a: 0.004, dur: 0.12, f0: r.r(220, 300), f1: 650, amp: 0.6 });
    s.noise({ a: 0.006, dur: 0.45, f0: 1500, f1: 500, q: 0.6, amp: 1, am: 0.5, amRate: 120 });
    s.noise({ at: 0.15, a: 0.1, dur: 0.6, f0: 3200, q: 0.5, amp: 0.3, am: 0.9, amRate: 300 });
    for (let i = 0; i < 12; i++) {
      const f = r.r(700, 1800);
      s.tone({ at: r.r(0.15, 0.9), a: 0.003, dur: 0.03, f0: f, f1: f * 2, amp: r.r(0.05, 0.15) });
    }
  },
  rocketLoop: (s) => {
    s.noise({ dur: 2.2, hold: 2.2, a: 0.01, f0: 1100, q: 0.6, amp: 0.7, am: 0.6, amRate: 120 });
    s.noise({ dur: 2.2, hold: 2.2, a: 0.01, f0: 300, type: 'lp', amp: 0.6, am: 0.5, amRate: 60, brown: true });
    s.noise({ dur: 2.2, hold: 2.2, a: 0.01, f0: 5000, type: 'hp', amp: 0.2 });
  },
};

function chordStinger(s: Syn, a: number[], b: number[], win: boolean) {
  // brassy saws through a filter, two chords, a low hit underneath
  a.forEach((f, i) => {
    for (const det of [0.997, 1.003]) s.tone({ at: i * 0.11, a: 0.03, dur: 0.5, f0: f * det, wave: 'saw', amp: 0.18, lp: 1600 });
  });
  const t = 0.5;
  b.forEach((f) => {
    for (const det of [0.995, 1, 1.005]) s.tone({ at: t, a: 0.06, hold: 0.5, dur: win ? 1.8 : 2.4, f0: f * det, f1: win ? f * det : f * det * 0.985, wave: 'saw', amp: 0.14, lp: win ? 2600 : 1200 });
  });
  s.tone({ at: t, dur: 0.9, f0: win ? 110 : 82, f1: win ? 55 : 41, tau: 0.08, amp: 0.8, drive: 2 });
  s.noise({ at: t, a: 0.3, dur: 1.4, f0: 6000, type: 'hp', amp: 0.05 });
}

/** Rotary cannon at full spin: electric motor whine plus the barrel cluster chopping the air (played slower to spin down). */
function motorLoop(rng: Rng, sr: number) {
  const n = sr; // exactly one second: every partial below completes whole cycles
  const d = new Float32Array(n);
  const bp = new BQ('bp', sr).set(1600, 0.9);
  const lp = new BQ('lp', sr).set(2400, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ph = (t * 380) % 1;
    const whine = lp.run(2 * ph - 1) * 0.35 + Math.sin(2 * Math.PI * 760 * t) * 0.12 + Math.sin(2 * Math.PI * 1140 * t) * 0.05;
    const chop = 0.55 + 0.45 * Math.sin(2 * Math.PI * 48 * t);
    d[i] = whine + bp.run(rng.n()) * chop * 0.9 + Math.sin(2 * Math.PI * 96 * t) * 0.12;
  }
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[i]));
  for (let i = 0; i < n; i++) d[i] *= 0.9 / pk;
  // blend the first few ms of noise into the end so the loop point is clean
  const xf = Math.floor(sr * 0.01);
  for (let i = 0; i < xf; i++) d[n - xf + i] = d[n - xf + i] * (1 - i / xf) + d[i] * (i / xf);
  return d;
}

// -------------------------------------------------------------------------------- registry

const hash = (str: string) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** all variants of one sound as channel arrays, at the rate it wants for a context running at `ctxRate` */
export function renderSound(key: string, def: SoundDef, ctxRate: number): { sr: number; variants: Float32Array[][] } {
  const sr = def.half ? Math.round(ctxRate / 2) : ctxRate;
  const variants: Float32Array[][] = [];
  for (let v = 0; v < def.variants; v++) {
    const r = def.gen(new Rng(hash(key) + v * 1013), sr, v);
    variants.push(r instanceof Float32Array ? [r] : r);
  }
  return { sr, variants };
}

const one = (len: number, fn: (s: Syn, r: Rng) => void, peak = 0.95) => (rng: Rng, sr: number) => {
  const s = new Syn(sr, len, rng);
  fn(s, rng);
  return s.fade(Math.min(0.05, len * 0.1)).norm(peak).d;
};

export function soundDefs(): Map<string, SoundDef> {
  const m = new Map<string, SoundDef>();
  for (const [id, g] of Object.entries(GUNS)) {
    m.set(`gun.${id}`, { variants: 3, gen: (r, sr) => gunClose(g, r, sr) });
    m.set(`gun.${id}.far`, { variants: 2, half: true, gen: (r, sr) => gunFar(g, r, sr) });
    m.set(`gun.${id}.sup`, { variants: 3, gen: (r, sr) => gunSuppressed(g, r, sr) });
  }
  const foleyLen: Record<string, number> = { ejectShells: 0.6, beltRattle: 0.4, medkit: 1.1, motorBlip: 0.45, tubeLoad: 0.5, pin: 0.4, draw: 0.3, brass: 0.35, bigBrass: 0.4, hull: 0.25 };
  for (const [k, fn] of Object.entries(FOLEY)) m.set(k, { variants: k === 'brass' || k === 'bigBrass' ? 4 : 2, gen: one(foleyLen[k] ?? 0.22, fn) });
  for (const [k, fn] of Object.entries(IMPACT)) m.set(`imp.${k}`, { variants: k === 'ric' ? 3 : 4, gen: one(k === 'metal' ? 0.5 : k === 'ric' ? 0.45 : 0.3, fn) });
  for (const [k, fn] of Object.entries(STEP)) m.set(`step.${k}`, { variants: 4, gen: one(k === 'water' ? 0.4 : 0.22, fn) });
  for (let size = 0; size < 3; size++) {
    m.set(`boom.${size}`, { variants: 2, gen: (r, sr) => boomClose(r, sr, size) });
    m.set(`boom.${size}.far`, { variants: 2, half: true, gen: (r, sr) => boomFar(r, sr, size) });
  }
  m.set('motorLoop', { variants: 1, gen: motorLoop });
  m.set('amb.river', { variants: 1, half: true, gen: riverLoop });
  m.set('amb.wind', { variants: 1, half: true, gen: windLoop });
  m.set('amb.leaves', { variants: 1, half: true, gen: leavesLoop });
  m.set('amb.insects', { variants: 1, gen: insectsLoop });
  BIRDS.forEach((fn, i) => m.set(`bird.${i}`, { variants: 2, gen: one(1.8, fn, 0.9) }));
  const uiLen: Record<string, number> = { deploy: 1.1, kill: 0.55, streak: 0.95, alarm: 1, win: 3, lose: 3.4, death: 2, ring: 2.8, flap: 1.5, smoke: 3.1, creakTree: 2.4, creakBuild: 1.2, crashTree: 1.5, crashRubble: 1.6, splashBig: 1.1, rocketLoop: 2.4, heart: 0.4, head: 0.4 };
  for (const [k, fn] of Object.entries(UI)) {
    const len = uiLen[k] ?? 0.25;
    if (k === 'rocketLoop') m.set(k, { variants: 1, half: true, gen: (r, sr) => { const s = new Syn(sr, len, r); fn(s, r); return s.norm(0.9).loop(0.2); } });
    else m.set(k, { variants: k === 'snap' || k === 'whiz' || k === 'hurt' ? 3 : 1, half: k === 'crashRubble' || k === 'creakBuild', gen: one(len, fn) });
  }
  return m;
}
