// Tiny offline DSP kit. Sounds are rendered once into Float32Arrays (then AudioBuffers) so that playing
// one at runtime costs a single buffer source instead of a stack of live oscillators and filters.
// Every layer is peak-normalised before it is mixed in, so `amp` means "loudest sample of this layer".

export class Rng {
  constructor(private s: number) {}
  f() {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** -1..1 */
  n() {
    return this.f() * 2 - 1;
  }
  r(a: number, b: number) {
    return a + (b - a) * this.f();
  }
  /** multiply by a random factor of ±k */
  j(v: number, k = 0.05) {
    return v * (1 + this.n() * k);
  }
}

export type FilterType = 'lp' | 'hp' | 'bp' | 'peak' | 'none';

/** RBJ biquad, direct form I. */
export class BQ {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private type: FilterType, private sr: number) {}
  set(f: number, q = 0.707, db = 0) {
    if (this.type === 'none') return this;
    const w = (2 * Math.PI * Math.min(Math.max(f, 10), this.sr * 0.45)) / this.sr;
    const cs = Math.cos(w), sn = Math.sin(w);
    const al = sn / (2 * Math.max(0.05, q));
    const A = Math.pow(10, db / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (this.type) {
      case 'lp':
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
        break;
      case 'hp':
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
        break;
      case 'bp':
        b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
        break;
      default:
        b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x: number) {
    if (this.type === 'none') return x;
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export type Wave = 'sin' | 'tri' | 'saw' | 'sqr';

export interface NoiseOpts {
  at?: number;
  dur: number; // decay time to -60 dB
  a?: number; // attack
  hold?: number;
  f0: number;
  f1?: number;
  q?: number;
  type?: FilterType;
  amp: number;
  /** 0..1: random crackle modulation depth */
  am?: number;
  amRate?: number;
  /** decay curve exponent (<1 fast start, >1 holds then drops) */
  curve?: number;
  /** second pass through the same filter shape (steeper) */
  steep?: boolean;
  /** brown-ish noise (more low end) */
  brown?: boolean;
}

export interface ToneOpts {
  at?: number;
  dur: number;
  a?: number;
  hold?: number;
  f0: number;
  f1?: number;
  /** pitch glide time constant; omit for an exponential glide over the whole duration */
  tau?: number;
  amp: number;
  wave?: Wave;
  drive?: number;
  vib?: number; // vibrato depth (ratio)
  vibF?: number;
  curve?: number;
  lp?: number;
}

export type Mode = [freq: number, decay: number, amp: number];

const env = (t: number, a: number, hold: number, dur: number, curve: number) => {
  if (t < a) return t / a;
  const u = t - a - hold;
  if (u < 0) return 1;
  const p = u / dur;
  return Math.exp(-6.9 * (curve === 1 ? p : Math.pow(p, curve)));
};

const addNorm = (dst: Float32Array, start: number, tmp: Float32Array, amp: number) => {
  let pk = 0;
  for (let i = 0; i < tmp.length; i++) {
    const v = Math.abs(tmp[i]);
    if (v > pk) pk = v;
  }
  if (pk < 1e-9) return;
  const k = amp / pk;
  const n = Math.min(tmp.length, dst.length - start);
  for (let i = 0; i < n; i++) dst[start + i] += tmp[i] * k;
};

/** A sound under construction. */
export class Syn {
  readonly d: Float32Array;
  constructor(readonly sr: number, sec: number, readonly rng: Rng) {
    this.d = new Float32Array(Math.max(1, Math.ceil(sec * sr)));
  }
  get len() {
    return this.d.length / this.sr;
  }

  noise(o: NoiseOpts) {
    const sr = this.sr, rng = this.rng;
    const at = o.at ?? 0, a = o.a ?? 0.0006, hold = o.hold ?? 0, curve = o.curve ?? 1;
    const total = a + hold + o.dur;
    const start = Math.floor(at * sr);
    const n = Math.min(Math.ceil(total * sr), this.d.length - start);
    if (n <= 0) return this;
    const type = o.type ?? 'bp';
    const q = o.q ?? 0.7;
    const f0 = o.f0, f1 = o.f1 ?? o.f0;
    const sweep = f1 !== f0;
    const fa = new BQ(type, sr).set(f0, q);
    const fb = o.steep ? new BQ(type, sr).set(f0, q) : null;
    const tmp = new Float32Array(n);
    const am = o.am ?? 0, amRate = (o.amRate ?? 60) / sr;
    let c = 1, br = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if (sweep && (i & 31) === 0) {
        const p = Math.min(1, t / total);
        const f = f0 * Math.pow(f1 / f0, p);
        fa.set(f, q);
        fb?.set(f, q);
      }
      let x = rng.n();
      if (o.brown) {
        br = br * 0.97 + x * 0.25;
        x = br;
      }
      x = fa.run(x);
      if (fb) x = fb.run(x);
      if (am > 0) {
        if (rng.f() < amRate) c = 0.3 + rng.f() * 0.7;
        c *= 0.9985;
        x *= 1 - am + am * c * 1.6;
      }
      tmp[i] = x * env(t, a, hold, o.dur, curve);
    }
    addNorm(this.d, start, tmp, o.amp);
    return this;
  }

  tone(o: ToneOpts) {
    const sr = this.sr;
    const at = o.at ?? 0, a = o.a ?? 0.001, hold = o.hold ?? 0, curve = o.curve ?? 1;
    const total = a + hold + o.dur;
    const start = Math.floor(at * sr);
    const n = Math.min(Math.ceil(total * sr), this.d.length - start);
    if (n <= 0) return this;
    const f0 = o.f0, f1 = o.f1 ?? o.f0;
    const wave = o.wave ?? 'sin';
    const drive = o.drive ?? 0;
    const vib = o.vib ?? 0, vibF = o.vibF ?? 6;
    const lp = o.lp ? new BQ('lp', sr).set(o.lp, 0.6) : null;
    const tmp = new Float32Array(n);
    let ph = this.rng.f();
    const dn = drive > 0 ? Math.tanh(drive) : 1;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let f: number;
      if (o.tau !== undefined) f = f1 + (f0 - f1) * Math.exp(-t / o.tau);
      else f = f0 * Math.pow(f1 / f0, Math.min(1, t / total));
      if (vib) f *= 1 + vib * Math.sin(2 * Math.PI * vibF * t);
      ph += f / sr;
      ph -= Math.floor(ph);
      let x: number;
      switch (wave) {
        case 'tri': x = 1 - 4 * Math.abs(ph - 0.5); break;
        case 'saw': x = 2 * ph - 1; break;
        case 'sqr': x = ph < 0.5 ? 1 : -1; break;
        default: x = Math.sin(2 * Math.PI * ph);
      }
      if (drive > 0) x = Math.tanh(x * drive) / dn;
      if (lp) x = lp.run(x);
      tmp[i] = x * env(t, a, hold, o.dur, curve);
    }
    addNorm(this.d, start, tmp, o.amp);
    return this;
  }

  /** Struck metal / wood: decaying inharmonic partials plus a short strike transient. */
  modal(at: number, modes: Mode[], amp: number, strike = 0.0015, bright = 2500) {
    const sr = this.sr, rng = this.rng;
    let longest = strike;
    for (const m of modes) longest = Math.max(longest, m[1]);
    const start = Math.floor(at * sr);
    const n = Math.min(Math.ceil((longest + 0.002) * sr), this.d.length - start);
    if (n <= 0) return this;
    const tmp = new Float32Array(n);
    for (const [f0, dec, ma] of modes) {
      const f = rng.j(f0, 0.03);
      const ph = rng.f() * Math.PI * 2;
      const w = (2 * Math.PI * f) / sr;
      const k = -6.9 / (dec * sr);
      const m = Math.min(n, Math.ceil(dec * sr));
      for (let i = 0; i < m; i++) tmp[i] += Math.sin(w * i + ph) * Math.exp(k * i) * ma * Math.min(1, i / (sr * 0.0003));
    }
    const hp = new BQ('hp', sr).set(bright, 0.7);
    const sn = Math.ceil(strike * sr);
    let pk = 0;
    for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(tmp[i]));
    for (let i = 0; i < Math.min(sn, n); i++) tmp[i] += hp.run(rng.n()) * (1 - i / sn) * pk * 0.9;
    addNorm(this.d, start, tmp, amp);
    return this;
  }

  /** Supersonic N-wave: a sharp pressure spike, a linear fall below zero and a snap back. */
  crack(at: number, amp: number, len = 0.0007) {
    const sr = this.sr;
    const start = Math.floor(at * sr);
    const n = Math.max(3, Math.round(len * sr));
    const tmp = new Float32Array(n + 4);
    for (let i = 0; i < n; i++) tmp[i] = 1 - (2 * i) / n;
    tmp[n] = -0.4;
    tmp[n + 1] = -0.1;
    addNorm(this.d, start, tmp, amp);
    return this;
  }

  /** A run of tiny ticks (debris, belt links, gravel crunch) between t0 and t1. */
  ticks(t0: number, t1: number, count: number, f0: number, f1: number, amp: number, decay = 0.012, fall = 1) {
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const u = Math.pow(rng.f(), fall);
      const t = t0 + (t1 - t0) * u;
      const f = rng.r(f0, f1);
      const a = amp * rng.r(0.3, 1) * (fall > 1 ? 1 - u * 0.7 : 1);
      this.modal(t, [[f, decay * rng.r(0.6, 1.3), 1], [f * rng.r(1.4, 2.3), decay * 0.6, 0.5]], a, 0.0008, f * 0.8);
    }
    return this;
  }

  /** Mix a delayed, low-passed copy of the current sound back in (ground bounce, terrain echo). */
  echo(delay: number, gain: number, lpF = 2000, hpF = 0) {
    const sr = this.sr;
    const off = Math.floor(delay * sr);
    if (off >= this.d.length) return this;
    const src = this.d.slice(0, this.d.length - off);
    const lp = new BQ('lp', sr).set(lpF, 0.6);
    const hp = hpF > 0 ? new BQ('hp', sr).set(hpF, 0.6) : null;
    for (let i = 0; i < src.length; i++) {
      let x = lp.run(src[i]);
      if (hp) x = hp.run(x);
      this.d[off + i] += x * gain;
    }
    return this;
  }

  filter(type: FilterType, f: number, q = 0.707, db = 0) {
    const b = new BQ(type, this.sr).set(f, q, db);
    for (let i = 0; i < this.d.length; i++) this.d[i] = b.run(this.d[i]);
    return this;
  }

  /** soft saturation; normalises first so the drive amount is predictable */
  drive(k: number) {
    this.norm(1);
    const dn = Math.tanh(k);
    for (let i = 0; i < this.d.length; i++) this.d[i] = Math.tanh(this.d[i] * k) / dn;
    return this;
  }

  norm(peak = 0.95) {
    let pk = 0;
    for (let i = 0; i < this.d.length; i++) pk = Math.max(pk, Math.abs(this.d[i]));
    if (pk > 1e-9) {
      const k = peak / pk;
      for (let i = 0; i < this.d.length; i++) this.d[i] *= k;
    }
    return this;
  }

  fade(sec = 0.01) {
    const n = Math.min(this.d.length, Math.floor(sec * this.sr));
    for (let i = 0; i < n; i++) this.d[this.d.length - 1 - i] *= i / n;
    return this;
  }

  /** fold the tail over the head so the buffer loops without a seam */
  loop(xf: number) {
    const n = Math.floor(xf * this.sr);
    const L = this.d.length - n;
    const out = new Float32Array(L);
    out.set(this.d.subarray(0, L));
    for (let i = 0; i < n; i++) {
      const k = i / n;
      out[i] = this.d[i] * Math.sqrt(k) + this.d[L + i] * Math.sqrt(1 - k);
    }
    return out;
  }
}

/** Stereo impulse response for an outdoor forest valley: a few early bounces, then a diffuse tail that darkens. */
export function forestIR(sr: number, sec: number, seed: number): [Float32Array, Float32Array] {
  const out: [Float32Array, Float32Array] = [new Float32Array(Math.floor(sec * sr)), new Float32Array(Math.floor(sec * sr))];
  for (let ch = 0; ch < 2; ch++) {
    const rng = new Rng(seed + ch * 7919);
    const d = out[ch];
    const pre = Math.floor(0.012 * sr);
    let lp = 0;
    for (let i = pre; i < d.length; i++) {
      const t = (i - pre) / sr;
      // tree trunks scatter high frequencies first: the tail gets darker as it decays
      const k = Math.min(0.95, 0.12 + t * 0.9);
      lp = lp * k + rng.n() * (1 - k);
      const e = Math.exp(-t * 4.2) * (t < 0.03 ? t / 0.03 : 1);
      d[i] = lp * e * (2.2 + t * 2);
    }
    // early reflections off nearby trunks and the ground
    for (let r = 0; r < 14; r++) {
      const t = 0.008 + rng.f() * 0.11;
      const i = Math.floor(t * sr);
      if (i < d.length) d[i] += rng.n() * 0.5 * Math.exp(-t * 9);
    }
  }
  return out;
}
