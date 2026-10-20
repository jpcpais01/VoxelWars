import * as THREE from 'three';
import { M } from '../world/materials';
import { forestIR } from './dsp';
import { GUNS, SoundDef, renderSound, soundDefs } from './sounds';

/**
 * Procedural audio engine. Every sound is synthesised once into a buffer (see sounds.ts), in the
 * background right after the first click, so a gunshot at runtime is a couple of buffer sources
 * through a short chain: air-absorption low-pass, stereo placement, then the dry bus plus sends to a
 * forest reverb and a valley echo. Distant sounds arrive late (speed of sound), darker and wetter, and
 * walls between you and the source muffle them.
 */

const SPEED_OF_SOUND = 343;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

class Bank {
  private defs: Map<string, SoundDef> = soundDefs();
  private cache = new Map<string, AudioBuffer[]>();
  private last = new Map<string, number>();
  private pending: string[] = [];
  private timer = 0;
  constructor(private ctx: BaseAudioContext) {}

  ready(key: string) {
    return this.cache.has(key);
  }
  all(key: string): AudioBuffer[] {
    return this.cache.get(key) ?? this.build(key);
  }
  /** a random variant, never the same one twice in a row */
  pick(key: string): AudioBuffer | null {
    const all = this.all(key);
    if (all.length === 0) return null;
    let i = (Math.random() * all.length) | 0;
    if (all.length > 1 && i === this.last.get(key)) i = (i + 1) % all.length;
    this.last.set(key, i);
    return all[i];
  }
  private store(key: string, sr: number, variants: Float32Array[][]) {
    const out = variants.map((chans) => {
      const b = this.ctx.createBuffer(chans.length, chans[0].length, sr);
      chans.forEach((c, i) => b.getChannelData(i).set(c));
      return b;
    });
    this.cache.set(key, out);
    return out;
  }
  /** synchronous fallback for a sound that is needed before the worker delivered it */
  private build(key: string): AudioBuffer[] {
    const def = this.defs.get(key);
    if (!def) {
      this.cache.set(key, []);
      return [];
    }
    const r = renderSound(key, def, this.ctx.sampleRate);
    return this.store(key, r.sr, r.variants);
  }
  /** render everything in the background, the given keys first */
  warm(first: string[]) {
    const order = [...first.filter((k) => this.defs.has(k)), ...[...this.defs.keys()].filter((k) => !first.includes(k))];
    try {
      const w = new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' });
      let left = order.length;
      w.onmessage = (e: MessageEvent<{ key: string; sr: number; variants: Float32Array[][] }>) => {
        if (!this.cache.has(e.data.key)) this.store(e.data.key, e.data.sr, e.data.variants);
        if (--left <= 0) w.terminate();
      };
      w.onerror = () => {
        w.terminate();
        this.slices(order);
      };
      w.postMessage({ keys: order, rate: this.ctx.sampleRate });
    } catch {
      this.slices(order);
    }
  }
  /** no worker: render on the main thread in small time slices */
  private slices(order: string[]) {
    this.pending = order.filter((k) => !this.cache.has(k));
    if (!this.timer) this.timer = window.setTimeout(this.pump, 0);
  }
  private pump = () => {
    const t0 = performance.now();
    while (this.pending.length && performance.now() - t0 < 7) {
      const k = this.pending.shift()!;
      if (!this.cache.has(k)) this.build(k);
    }
    this.timer = this.pending.length ? window.setTimeout(this.pump, 12) : 0;
  };
}

interface Place {
  gain: number;
  pan: number;
  cut: number;
  dist: number;
  delay: number;
}

interface Chain {
  input: AudioNode;
  nodes: AudioNode[];
  /** sources still playing into it */
  refs: number;
}

interface Later {
  at: number;
  fn: (t: number) => void;
  valid?: () => boolean;
}

interface Loop {
  src: AudioBufferSourceNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  pan: StereoPannerNode;
}

interface Tracked extends Loop {
  p: { pos: THREE.Vector3; vel: THREE.Vector3; dead: boolean };
}

interface Spinner extends Loop {
  seen: number;
}

type Surface = 'grass' | 'dirt' | 'gravel' | 'sand' | 'stone' | 'wood' | 'metal';
const SURFACE: Surface[] = [];
{
  const set = (s: Surface, ids: number[]) => ids.forEach((i) => (SURFACE[i] = s));
  set('grass', [M.GRASS, M.FLOWER_BED, M.MOSS, M.FERN, M.BUSH, M.OAK_LEAF, M.PINE_LEAF, M.BIRCH_LEAF, M.AUTUMN_LEAF, M.RED_LEAF, M.HAY, M.CANVAS, M.SANDBAG]);
  set('dirt', [M.DIRT, M.MUD, M.CLAY, M.PATH]);
  set('gravel', [M.GRAVEL]);
  set('sand', [M.SAND]);
  set('stone', [M.STONE, M.CLIFF, M.MOSSY, M.BEDROCK, M.CONCRETE, M.CONCRETE_DARK, M.BRICK, M.MORTAR, M.WHITE_TRIM, M.ROOF_SLATE]);
  set('wood', [M.PLANK, M.PLANK_DARK, M.OAK_BARK, M.PINE_BARK, M.BIRCH_BARK, M.LOG_END, M.CRATE, M.BOAT, M.ROOF_RED]);
  set('metal', [M.METAL, M.STEEL_DARK, M.RUST, M.BARREL, M.HAZARD, M.TEAM_BLUE, M.TEAM_RED, M.GLOW_BLUE, M.GLOW_RED, M.LAMP]);
}

/** reload foley: [fraction of the reload, sound, gain]; 'shells' expands to one insert per round */
const RELOADS: Record<string, [number, string, number][]> = {
  ar: [[0.1, 'magOut', 0.8], [0.62, 'magIn', 1], [0.84, 'boltBack', 0.8], [0.9, 'boltFwd', 0.9]],
  smg: [[0.1, 'magOut', 0.8], [0.6, 'magIn', 1], [0.82, 'boltBack', 0.7], [0.88, 'boltFwd', 0.8]],
  dmr: [[0.1, 'magOut', 0.8], [0.62, 'magIn', 1], [0.88, 'boltFwd', 1]],
  sniper: [[0.05, 'boltUp', 0.7], [0.11, 'boltBack', 0.8], [0.2, 'magOut', 0.8], [0.62, 'magIn', 1], [0.82, 'boltFwd', 0.9], [0.9, 'boltDown', 0.9]],
  lmg: [[0.07, 'coverOpen', 0.9], [0.2, 'beltRattle', 0.7], [0.38, 'boxClunk', 0.9], [0.6, 'beltRattle', 0.8], [0.78, 'coverSlam', 1], [0.88, 'boltBack', 0.8], [0.94, 'boltFwd', 0.9]],
  shotgun: [[0.12, 'shells', 0.9], [0.86, 'pumpBack', 0.9], [0.93, 'pumpFwd', 1]],
  revolver: [[0.07, 'cylOpen', 0.9], [0.18, 'ejectShells', 0.8], [0.55, 'speedloader', 1], [0.82, 'cylClose', 1]],
  rocket: [[0.12, 'latch', 0.6], [0.42, 'tubeLoad', 1], [0.86, 'latch', 0.9]],
  gl: [[0.08, 'breachOpen', 0.9], [0.2, 'shellOut', 0.7], [0.38, 'shells', 0.9], [0.9, 'latch', 1]],
  minigun: [[0.08, 'latch', 0.7], [0.25, 'boxClunk', 0.8], [0.45, 'beltRattle', 0.8], [0.62, 'boxClunk', 1], [0.78, 'latch', 0.9], [0.9, 'motorBlip', 0.8]],
};

export class Audio {
  ctx: AudioContext | null = null;
  private bank!: Bank;
  private master!: GainNode;
  private sfx!: GainNode;
  private ui!: GainNode;
  private amb!: GainNode;
  private muffle!: BiquadFilterNode;
  private revIn!: GainNode;
  private echoIn!: GainNode;
  listener = new THREE.Vector3();
  /** heading of the listener (atan2(dx, dz)); sounds pan relative to it */
  listenerYaw = Math.PI;
  volume = 0.8;
  /** 0 = clear line, 1 = solid wall between the listener and the point (set by the game) */
  occlusion: ((x: number, y: number, z: number) => number) | null = null;
  private occCache = new Map<number, { t: number; v: number }>();
  private recent = new Map<string, number>();
  private queue: Later[] = [];
  private voices = 0;
  private ambLoops: Record<string, Loop> | null = null;
  private spins = new Map<object, Spinner>();
  private tracked: Tracked[] = [];
  private intensity = 0;
  private birdT = 2;
  private scatterT = 0;
  private gust = 0;
  private gustV = 0;
  private hp = 100;
  private heartT = 0;
  private stepSide = 1;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.002;
    comp.release.value = 0.22;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -2;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.09;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    comp.connect(lim).connect(this.master).connect(ctx.destination);

    // world sounds pass through a low-pass that closes when a blast goes off next to you
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 22000;
    this.muffle.Q.value = 0.4;
    this.muffle.connect(comp);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.72;
    this.sfx.connect(this.muffle);
    this.amb = ctx.createGain();
    this.amb.gain.value = 0.6;
    this.amb.connect(this.muffle);
    this.ui = ctx.createGain();
    this.ui.gain.value = 0.8;
    this.ui.connect(comp);

    // forest reverb
    this.revIn = ctx.createGain();
    const conv = ctx.createConvolver();
    const [l, r] = forestIR(ctx.sampleRate, 1.5, 77);
    const ir = ctx.createBuffer(2, l.length, ctx.sampleRate);
    ir.getChannelData(0).set(l);
    ir.getChannelData(1).set(r);
    conv.normalize = true;
    conv.buffer = ir;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.55;
    this.revIn.connect(conv).connect(revOut).connect(this.muffle);

    // slapback off the valley sides: two dark, panned delay taps with a little feedback
    this.echoIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 200;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1900;
    this.echoIn.connect(hp).connect(lp);
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.5;
    echoOut.connect(this.muffle);
    echoOut.connect(this.revIn);
    for (const [time, pan, fb] of [[0.31, -0.65, 0.3], [0.47, 0.6, 0.26]] as const) {
      const d = ctx.createDelay(1);
      d.delayTime.value = time;
      const f = ctx.createGain();
      f.gain.value = fb;
      const dark = ctx.createBiquadFilter();
      dark.type = 'lowpass';
      dark.frequency.value = 1400;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      lp.connect(d);
      d.connect(dark).connect(f).connect(d);
      d.connect(p).connect(echoOut);
    }

    this.bank = new Bank(ctx);
    this.bank.warm(['click', 'hover', 'amb.river', 'amb.wind', 'amb.leaves', 'amb.insects', 'deploy', 'gun.ar', 'gun.ar.far', 'hit', 'head', 'kill']);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  // ----------------------------------------------------------------------------- plumbing

  private now() {
    return this.ctx!.currentTime;
  }

  private limit(key: string, ms: number) {
    const now = performance.now();
    const last = this.recent.get(key) ?? -1e9;
    if (now - last < ms) return false;
    this.recent.set(key, now);
    return true;
  }

  /** how much solid world lies between the listener and a point (cached per 2 m cell for a moment) */
  private occ(pos: THREE.Vector3, d: number) {
    if (!this.occlusion || d < 3) return 0;
    const key = (Math.round(pos.x / 2) * 4096 + Math.round(pos.z / 2)) * 64 + Math.round(pos.y / 2);
    const now = performance.now();
    const c = this.occCache.get(key);
    if (c && now - c.t < 250) return c.v;
    const v = this.occlusion(pos.x, pos.y, pos.z);
    if (this.occCache.size > 256) this.occCache.clear();
    this.occCache.set(key, { t: now, v });
    return v;
  }

  /**
   * Where a sound sits for the listener. `ref` is the distance at which it is at half level,
   * `law` 1 falls off like real sound pressure (loud things carry), 2 falls off fast (small foley).
   */
  private place(pos: THREE.Vector3, ref: number, law = 2, occlude = false, air = 45): Place {
    const L = this.listener;
    const dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
    const dist = Math.hypot(dx, dy, dz);
    const cy = Math.cos(this.listenerYaw), sy = Math.sin(this.listenerYaw);
    const side = -dx * cy + dz * sy;
    const front = dx * sy + dz * cy;
    const hd = Math.hypot(side, front) + 1e-6;
    const pan = clamp(side / (hd + 1.2), -0.92, 0.92);
    let gain = 1 / (1 + Math.pow(dist / ref, law));
    let cut = 20000 * Math.exp(-dist / air);
    // sounds behind the head lose some of their top end
    if (front < 0) cut *= 1 - 0.45 * (-front / hd);
    if (occlude) {
      const o = this.occ(pos, dist);
      if (o > 0) {
        cut *= 1 - 0.8 * o;
        gain *= 1 - 0.45 * o;
      }
    }
    return { gain, pan, cut: Math.max(380, cut), dist, delay: dist / SPEED_OF_SOUND };
  }

  /** input → [air low-pass] → [pan] → dry level → bus, with absolute-level sends to the reverb and the echo */
  private chain(p: Place | null, wet: number, echo = 0, bus: AudioNode = this.sfx, dry = 1): Chain {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    const nodes: AudioNode[] = [input];
    let last: AudioNode = input;
    if (p && p.cut < 15000) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = p.cut;
      f.Q.value = 0.5;
      last.connect(f);
      last = f;
      nodes.push(f);
    }
    if (p && Math.abs(p.pan) > 0.02) {
      const pn = ctx.createStereoPanner();
      pn.pan.value = p.pan;
      last.connect(pn);
      last = pn;
      nodes.push(pn);
    }
    const g = ctx.createGain();
    g.gain.value = (p ? p.gain : 1) * dry;
    last.connect(g).connect(bus);
    nodes.push(g);
    if (wet > 0.004) {
      const s = ctx.createGain();
      s.gain.value = wet;
      last.connect(s).connect(this.revIn);
      nodes.push(s);
    }
    if (echo > 0.004) {
      const s = ctx.createGain();
      s.gain.value = echo;
      last.connect(s).connect(this.echoIn);
      nodes.push(s);
    }
    return { input, nodes, refs: 0 };
  }

  /** start a bank sound into a chain; the chain is torn down when its last source ends */
  private play(key: string, ch: Chain, t: number, gain = 1, rate = 1): AudioBufferSourceNode | null {
    const buf = this.bank.pick(key);
    if (!buf || gain < 0.002) return null;
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    if (rate !== 1) s.playbackRate.value = rate;
    let out: AudioNode = s;
    if (gain !== 1) {
      const g = ctx.createGain();
      g.gain.value = gain;
      s.connect(g);
      out = g;
    }
    out.connect(ch.input);
    this.voices++;
    ch.refs++;
    s.onended = () => {
      this.voices--;
      out.disconnect();
      if (--ch.refs <= 0) for (const n of ch.nodes) n.disconnect();
    };
    s.start(Math.max(t, ctx.currentTime));
    return s;
  }

  /** room for one more voice? quiet ones give way first when the mix is crowded */
  private room(level: number, important = false) {
    if (important) return this.voices < 140;
    if (this.voices > 90) return false;
    if (this.voices > 56) return level > 0.25;
    return level > 0.004;
  }

  private later(delay: number, fn: (t: number) => void, valid?: () => boolean) {
    this.queue.push({ at: this.now() + delay, fn, valid });
  }

  private flush() {
    const now = this.now();
    let w = 0;
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      if (q.at <= now + 0.05) {
        if (!q.valid || q.valid()) q.fn(Math.max(q.at, now));
      } else this.queue[w++] = q;
    }
    this.queue.length = w;
  }

  /** a small foley sound, head-locked when `pos` is null */
  private foley(key: string, pos: THREE.Vector3 | null, gain: number, t = this.now(), ref = 5, rate = 1) {
    const P = pos ? this.place(pos, ref, 2, false, 30) : null;
    if (P && !this.room(P.gain * gain)) return;
    const ch = this.chain(P, 0.06 * gain * (P ? 1 / (1 + P.dist / 20) : 0.5));
    this.play(key, ch, t + (P?.delay ?? 0), gain, rate * (0.97 + Math.random() * 0.06));
  }

  private makeLoop(key: string, bus: AudioNode, wet = 0): Loop | null {
    const buf = this.bank.pick(key);
    if (!buf) return null;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 20000;
    const pan = ctx.createStereoPanner();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(pan).connect(gain).connect(bus);
    if (wet > 0) {
      const s = ctx.createGain();
      s.gain.value = wet;
      gain.connect(s).connect(this.revIn);
    }
    src.start(ctx.currentTime, Math.random() * buf.duration);
    return { src, gain, filter, pan };
  }

  private stopLoop(l: Loop, fade = 0.08) {
    const t = this.now();
    l.gain.gain.cancelScheduledValues(t);
    l.gain.gain.setTargetAtTime(0, t, fade / 3);
    l.src.stop(t + fade * 2);
    l.src.onended = () => l.gain.disconnect();
  }

  private aim(l: Loop, P: Place | null, gain: number, tc = 0.04) {
    const t = this.now();
    l.gain.gain.setTargetAtTime(gain * (P ? P.gain : 1), t, tc);
    l.filter.frequency.setTargetAtTime(P ? P.cut : 20000, t, tc);
    l.pan.pan.setTargetAtTime(P ? P.pan : 0, t, tc);
  }

  /** close blasts dull everything for a moment, and very close ones leave your ears ringing */
  private deafen(k: number, hold = 0.25) {
    if (k <= 0.05) return;
    const t = this.now();
    const f = this.muffle.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.setTargetAtTime(Math.max(260, 3800 * (1 - k)), t, 0.012);
    f.setTargetAtTime(22000, t + hold + k * 0.9, 0.5 + k * 0.9);
    if (k > 0.35 && this.limit('ring', 1200)) this.play('ring', this.chain(null, 0, 0, this.ui), t, 0.1 * k);
  }

  // -------------------------------------------------------------------------------- guns

  gunshot(
    id: string,
    pos: THREE.Vector3,
    o: { suppressed: boolean; loud: number; isPlayer: boolean; left: number; mag: number; owner: THREE.Vector3; valid?: () => boolean },
  ) {
    if (!this.ctx) return;
    const g = GUNS[id] ?? GUNS.ar;
    const gid = GUNS[id] ? id : 'ar';
    if (!o.isPlayer && !this.limit('gun' + Math.round(pos.x / 3) + ',' + Math.round(pos.z / 3), 40)) return;
    const sup = o.suppressed;
    const loud = sup ? 1 : clamp(o.loud, 0.6, 1.8);
    const P = o.isPlayer ? null : this.place(pos, sup ? 4.5 : 11 * loud, sup ? 2 : 1, true, sup ? 25 : 60);
    const dist = P?.dist ?? 0;
    const level = g.gain * (P ? P.gain : 0.82) * (loud > 1.2 ? 1.18 : 1);
    if (!this.room(level, o.isPlayer)) return;
    this.intensity = Math.min(1, this.intensity + (sup ? 0.01 : 0.06) / (1 + dist / 40));
    const t0 = this.now() + (P?.delay ?? 0);
    const wet = (sup ? 0.08 : 0.3) * g.gain * loud / (1 + dist / 70);
    const echo = sup ? 0 : 0.2 * g.gain * loud / (1 + dist / 90);
    const ch = this.chain(P, wet, echo, this.sfx, g.gain * (loud > 1.2 ? 1.18 : 1) * (o.isPlayer ? 0.82 : 1));
    const rate = 0.97 + Math.random() * 0.06;
    // close layer fades into the distant boom as the shooter gets further away
    const near = o.isPlayer ? 1 : 1 / (1 + (dist / 32) ** 2);
    const far = sup ? 0 : o.isPlayer ? 0.3 : 0.18 + 0.8 * smooth(3, 40, dist);
    this.play(sup ? `gun.${gid}.sup` : `gun.${gid}`, ch, t0, sup ? 0.6 : near, rate);
    if (far > 0.01) this.play(`gun.${gid}.far`, ch, t0 + 0.004, far, rate);

    // the shooter's own mechanics
    const self = o.isPlayer ? null : o.owner;
    const hear = o.isPlayer || dist < 22;
    if (o.isPlayer && o.mag >= 8 && o.left > 0 && o.left <= o.mag * 0.3) {
      const k = 1 - o.left / (o.mag * 0.3);
      this.foley('lowAmmo', null, 0.1 + 0.18 * k, t0 + 0.03, 5, 1 + k * 0.3);
    }
    if (o.left === 0 && (id === 'ar' || id === 'smg' || id === 'dmr' || id === 'lmg')) this.later(0.05, (t) => this.foley('boltLock', self, 0.45, t), o.valid);
    if (hear && id === 'shotgun') {
      this.later(0.2, (t) => this.foley('pumpBack', self, 0.75, t), o.valid);
      this.later(0.34, (t) => this.foley('hull', self, 0.22, t + Math.random() * 0.1), o.valid);
      this.later(0.52, (t) => this.foley('pumpFwd', self, 0.85, t), o.valid);
    }
    if (hear && id === 'sniper') {
      this.later(0.13, (t) => this.foley('boltUp', self, 0.6, t), o.valid);
      this.later(0.24, (t) => this.foley('boltBack', self, 0.75, t), o.valid);
      this.later(0.4, (t) => this.foley('bigBrass', self, 0.22, t + Math.random() * 0.1), o.valid);
      this.later(0.45, (t) => this.foley('boltFwd', self, 0.85, t), o.valid);
      this.later(0.6, (t) => this.foley('boltDown', self, 0.75, t), o.valid);
    }
    if ((g.shell === 'brass' || g.shell === 'big') && (o.isPlayer ? this.limit('brassP', 95) : dist < 9 && this.limit('brass', 180))) {
      this.later(0.3 + Math.random() * 0.25, (t) => this.foley(g.shell === 'big' ? 'bigBrass' : 'brass', self, o.isPlayer ? 0.16 : 0.2, t, 4));
    }
  }

  reload(id: string, pos: THREE.Vector3, isPlayer: boolean, dur: number, rounds: number, valid?: () => boolean) {
    if (!this.ctx) return;
    if (!isPlayer && this.place(pos, 5).gain < 0.01) return;
    const seq = RELOADS[id] ?? RELOADS.ar;
    const at = isPlayer ? null : pos;
    const g = isPlayer ? 0.62 : 0.85;
    for (const [frac, key, gain] of seq) {
      if (key === 'shells') {
        // one shell at a time, spread over the middle of the reload
        const n = Math.max(1, Math.min(rounds, 8));
        const span = (id === 'gl' ? 0.48 : 0.7) * dur;
        for (let i = 0; i < n; i++) this.later(frac * dur + (span * i) / n, (t) => this.foley('shellIn', at, g * gain, t, 5, id === 'gl' ? 0.8 : 1), valid);
      } else this.later(frac * dur, (t) => this.foley(key, at, g * gain, t), valid);
    }
  }

  dryFire(pos: THREE.Vector3, isPlayer = false) {
    if (!this.ctx || !this.limit('dry', 120)) return;
    this.foley('dry', isPlayer ? null : pos, 0.5, this.now(), 4);
  }

  /** a weapon coming up after a swap */
  draw(_id: string) {
    if (!this.ctx) return;
    this.foley('draw', null, 0.4);
  }

  /** an attachment clicking onto a gun in the armoury */
  attach() {
    if (!this.ctx) return;
    this.foley(Math.random() < 0.5 ? 'latch' : 'magIn', null, 0.3);
  }

  ads(on: boolean) {
    if (!this.ctx || !this.limit('ads', 140)) return;
    this.foley('ads', null, 0.09, this.now(), 5, on ? 1.1 : 0.88);
  }

  /** rotary cannon motor: call every frame while the gun is held; it fades out by itself */
  spin(key: object, pos: THREE.Vector3, spin: number, isPlayer: boolean) {
    if (!this.ctx) return;
    let v = this.spins.get(key);
    const P = isPlayer ? null : this.place(pos, 7, 2, true, 40);
    if (!v) {
      if (spin < 0.02 || (P && P.gain < 0.02) || !this.bank.ready('motorLoop')) return;
      const l = this.makeLoop('motorLoop', this.sfx, 0.05);
      if (!l) return;
      v = { ...l, seen: 0 };
      this.spins.set(key, v);
    }
    v.seen = this.now();
    v.src.playbackRate.setTargetAtTime(0.28 + 0.72 * spin, v.seen, 0.03);
    this.aim(v, P, Math.pow(spin, 0.8) * (isPlayer ? 0.32 : 0.45));
  }

  /** follow a rocket in flight: motor roar with doppler */
  rocket(p: { pos: THREE.Vector3; vel: THREE.Vector3; dead: boolean }) {
    if (!this.ctx || !this.bank.ready('rocketLoop')) return;
    const l = this.makeLoop('rocketLoop', this.sfx, 0.12);
    if (l) this.tracked.push({ ...l, p });
  }

  /** a bullet passing close to the listener */
  whiz(pos: THREE.Vector3, sonic: boolean) {
    if (!this.ctx || !this.limit('whiz', 60)) return;
    const P = this.place(pos, 3);
    P.pan = clamp(P.pan * 1.4, -0.95, 0.95);
    P.delay = 0;
    const ch = this.chain(P, 0.08);
    if (sonic) this.play('snap', ch, this.now(), 0.5);
    this.play('whiz', ch, this.now(), sonic ? 0.3 : 0.5, 0.9 + Math.random() * 0.2);
  }

  // -------------------------------------------------------------------------- the world

  explosion(pos: THREE.Vector3, size = 1) {
    if (!this.ctx) return;
    const cls = size < 0.45 ? 0 : size < 1.15 ? 1 : 2;
    if (cls === 0 && !this.limit('boomS', 45)) return;
    const P = this.place(pos, 14 + size * 16, 1, true, 75);
    const vol = Math.min(1.5, 0.55 + size * 0.6);
    if (!this.room(P.gain * vol, cls > 0)) return;
    const t = this.now() + P.delay;
    const near = 1 / (1 + (P.dist / (30 + 14 * size)) ** 2);
    const far = 0.2 + 0.8 * smooth(8, 60, P.dist);
    const ch = this.chain(P, (0.55 * vol) / (1 + P.dist / 90), (0.45 * vol) / (1 + P.dist / 110), this.sfx, vol);
    this.play(`boom.${cls}`, ch, t, near, 0.94 + Math.random() * 0.1);
    this.play(`boom.${cls}.far`, ch, t + 0.01, far * 0.9, 0.94 + Math.random() * 0.1);
    this.intensity = Math.min(1, this.intensity + (0.25 + size * 0.25) / (1 + P.dist / 50));
    const reach = 4 + size * 5;
    if (P.dist < reach) {
      const k = 1 - P.dist / reach;
      this.later(P.delay, () => this.deafen(k * Math.min(1, 0.5 + size * 0.5)));
    }
  }

  impact(pos: THREE.Vector3, kind: string) {
    if (!this.ctx || !this.limit('imp', 16)) return;
    const k = kind === 'glow' ? 'metal' : kind;
    const key = `imp.${['ground', 'stone', 'build', 'wood', 'leaf', 'metal', 'soft', 'water'].includes(k) ? k : 'ground'}`;
    const P = this.place(pos, 7, 2, false, 35);
    const g = k === 'metal' ? 0.5 : 0.6;
    if (!this.room(P.gain * g)) return;
    const ch = this.chain(P, 0.08 / (1 + P.dist / 25));
    const t = this.now() + P.delay;
    this.play(key, ch, t, g, 0.92 + Math.random() * 0.16);
    if ((k === 'stone' || k === 'metal' || k === 'build') && Math.random() < 0.13 && this.limit('ric', 220)) this.play('imp.ric', ch, t + 0.01, 0.32, 0.9 + Math.random() * 0.2);
  }

  flesh(pos: THREE.Vector3) {
    if (!this.ctx || !this.limit('flesh', 25)) return;
    const P = this.place(pos, 8);
    if (!this.room(P.gain * 0.6)) return;
    this.play('imp.flesh', this.chain(P, 0.04), this.now() + P.delay, 0.6, 0.92 + Math.random() * 0.16);
  }

  foot(pos: THREE.Vector3, vol: number, mat: number = M.GRASS, isPlayer = false, running = false) {
    if (!this.ctx) return;
    if (!isPlayer && !this.limit('foot' + Math.round(pos.x) + ',' + Math.round(pos.z), 90)) return;
    const surf = SURFACE[mat] ?? 'dirt';
    let P: Place | null = null;
    if (isPlayer) {
      // your own feet alternate a touch left and right
      this.stepSide = -this.stepSide;
      P = { gain: 1, pan: 0.1 * this.stepSide, cut: 20000, dist: 0, delay: 0 };
    } else P = this.place(pos, 4.5, 2, false, 30);
    const g = (isPlayer ? 0.2 : 0.55) * vol * (running ? 1.25 : 1);
    if (!this.room(P.gain * g)) return;
    const ch = this.chain(P, 0.025);
    const t = this.now() + P.delay;
    this.play(`step.${surf}`, ch, t, g, 0.92 + Math.random() * 0.16);
    if (vol >= 1.4) this.play('step.dirt', ch, t, g * 0.9, 0.62); // jump push-off / hard landing
    if (running && Math.random() < 0.6) this.play('step.gear', ch, t + 0.02, g * 0.35, 0.9 + Math.random() * 0.2);
  }

  splash(pos: THREE.Vector3, vol: number) {
    if (!this.ctx || !this.limit('spl', 50)) return;
    const P = this.place(pos, vol > 0.5 ? 12 : 5, 2, false, 40);
    const big = vol >= 0.55;
    const g = big ? Math.min(1, 0.45 * vol) : 0.6 * vol + 0.2;
    if (!this.room(P.gain * g)) return;
    const ch = this.chain(P, 0.08);
    this.play(big ? 'splashBig' : 'step.water', ch, this.now() + P.delay, g, 0.9 + Math.random() * 0.2);
  }

  creak(pos: THREE.Vector3, tree: boolean) {
    if (!this.ctx) return;
    const P = this.place(pos, 16, 1, true, 50);
    if (!this.room(P.gain * 0.7, true)) return;
    this.play(tree ? 'creakTree' : 'creakBuild', this.chain(P, 0.25 / (1 + P.dist / 40)), this.now() + P.delay, 0.7, 0.9 + Math.random() * 0.2);
  }

  crash(pos: THREE.Vector3, size: number, tree = false) {
    if (!this.ctx || !this.limit('crash', 90)) return;
    const P = this.place(pos, 18, 1, true, 55);
    const g = Math.min(1.1, 0.45 + size / 700);
    if (!this.room(P.gain * g, true)) return;
    this.play(tree ? 'crashTree' : 'crashRubble', this.chain(P, 0.35 / (1 + P.dist / 50), 0.15), this.now() + P.delay, g, 0.85 + Math.random() * 0.25);
  }

  throwSnd(pos: THREE.Vector3, kind = 'frag', isPlayer = false) {
    if (!this.ctx) return;
    const at = isPlayer ? null : pos;
    if (kind === 'frag' || kind === 'smoke') this.foley('pin', at, 0.4);
    this.foley('throw', at, 0.35, this.now() + 0.06);
  }

  bounce(pos: THREE.Vector3, speed: number) {
    if (!this.ctx || !this.limit('bnc' + Math.round(pos.x), 60)) return;
    this.foley('bounce', pos, Math.min(0.7, 0.15 + speed / 20), this.now(), 6);
  }

  smoke(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const P = this.place(pos, 8, 2, false, 40);
    this.play('smoke', this.chain(P, 0.1), this.now() + P.delay, 0.6);
  }

  stick(pos: THREE.Vector3) {
    if (!this.ctx) return;
    this.foley('stick', pos, 0.6, this.now(), 6);
    this.foley('beep', pos, 0.35, this.now() + 0.08, 7);
  }

  beep(pos: THREE.Vector3) {
    if (!this.ctx) return;
    this.foley('beep', pos, 0.35, this.now(), 7);
  }

  detonator(isPlayer: boolean, pos: THREE.Vector3) {
    if (!this.ctx) return;
    this.foley('detonator', isPlayer ? null : pos, 0.5, this.now(), 5);
  }

  medkit(pos: THREE.Vector3, isPlayer: boolean) {
    if (!this.ctx) return;
    this.foley('medkit', isPlayer ? null : pos, 0.45, this.now(), 5);
  }

  // ------------------------------------------------------------------------------- player

  /** you got hit: a thump from the direction the shot came from */
  hurt(dmg: number, dir: THREE.Vector3, killed: boolean) {
    if (!this.ctx) return;
    if (killed) {
      this.play('death', this.chain(null, 0.2, 0, this.ui), this.now(), 0.55);
      this.deafen(0.9, 1.6);
      return;
    }
    if (!this.limit('hurt', 70)) return;
    const from = new THREE.Vector3(this.listener.x - dir.x * 3, this.listener.y, this.listener.z - dir.z * 3);
    const P = this.place(from, 100);
    P.gain = 1;
    P.cut = 20000;
    P.delay = 0;
    this.play('hurt', this.chain(P, 0.05, 0, this.ui), this.now(), Math.min(0.75, 0.3 + dmg / 90));
  }

  vitals(hp: number) {
    this.hp = hp;
  }

  // ------------------------------------------------------------------------------------ UI

  hitmarker(kill: boolean, head = false) {
    if (!this.ctx || (!kill && !this.limit('hit', 35))) return;
    const ch = this.chain(null, kill ? 0.08 : 0, 0, this.ui);
    if (kill) this.play('kill', ch, this.now(), 0.55);
    else if (head) this.play('head', ch, this.now(), 0.42);
    else this.play('hit', ch, this.now(), 0.36, 0.96 + Math.random() * 0.08);
  }

  streak() {
    if (!this.ctx) return;
    this.play('streak', this.chain(null, 0.15, 0, this.ui), this.now() + 0.05, 0.35);
  }

  uiClick(v = 1) {
    if (!this.ctx) return;
    this.play('click', this.chain(null, 0, 0, this.ui), this.now(), 0.32 * v, 0.95 + Math.random() * 0.1);
  }

  uiHover() {
    if (!this.ctx || !this.limit('hover', 45)) return;
    this.play('hover', this.chain(null, 0, 0, this.ui), this.now(), 0.1, 0.95 + Math.random() * 0.1);
  }

  deploy() {
    if (!this.ctx) return;
    this.play('deploy', this.chain(null, 0.2, 0, this.ui), this.now(), 0.5);
  }

  alarm() {
    if (!this.ctx || !this.limit('alarm', 3500)) return;
    this.play('alarm', this.chain(null, 0.12, 0, this.ui), this.now(), 0.26);
  }

  fanfare(win: boolean) {
    if (!this.ctx) return;
    this.play(win ? 'win' : 'lose', this.chain(null, 0.35, 0, this.ui), this.now(), 0.6);
  }

  // ------------------------------------------------------------------------------ per frame

  /** update ambience levels from the listener position; also runs scheduled foley and moving sounds */
  updateAmbience(dt: number, distToRiver: number, wind: number) {
    if (!this.ctx) return;
    const t = this.now();
    this.flush();

    // moving loops
    for (const r of this.tracked) {
      if (r.p.dead) {
        this.stopLoop(r);
        continue;
      }
      const P = this.place(r.p.pos, 9, 1, true, 60);
      // doppler from the closing speed
      const L = this.listener;
      const vr = (r.p.vel.x * (L.x - r.p.pos.x) + r.p.vel.y * (L.y - r.p.pos.y) + r.p.vel.z * (L.z - r.p.pos.z)) / Math.max(0.5, P.dist);
      r.src.playbackRate.setTargetAtTime(clamp(SPEED_OF_SOUND / (SPEED_OF_SOUND - vr), 0.6, 1.6), t, 0.03);
      this.aim(r, P, 0.55, 0.03);
    }
    this.tracked = this.tracked.filter((r) => !r.p.dead);
    for (const [k, v] of this.spins) {
      if (t - v.seen > 0.2) {
        this.stopLoop(v, 0.15);
        this.spins.delete(k);
      }
    }

    // ambience beds
    if (!this.ambLoops && this.bank.ready('amb.river') && this.bank.ready('amb.wind') && this.bank.ready('amb.leaves') && this.bank.ready('amb.insects')) {
      const river = this.makeLoop('amb.river', this.amb, 0.05);
      const windL = this.makeLoop('amb.wind', this.amb);
      const leaves = this.makeLoop('amb.leaves', this.amb, 0.08);
      const insects = this.makeLoop('amb.insects', this.amb, 0.1);
      if (river && windL && leaves && insects) this.ambLoops = { river, wind: windL, leaves, insects };
    }
    this.intensity *= Math.exp(-dt / 14);
    const calm = 1 - this.intensity;
    // slow random gusts on top of the game's wind
    this.gustV += (Math.random() - 0.5) * dt * 1.2 - this.gust * dt * 0.4;
    this.gustV *= Math.exp(-dt * 0.8);
    this.gust = clamp(this.gust + this.gustV * dt, -0.6, 0.8);
    const w = clamp(wind + this.gust * 0.5, 0, 1.4);
    if (this.ambLoops) {
      const a = this.ambLoops;
      a.river.gain.gain.setTargetAtTime(0.02 + 0.55 / (1 + (distToRiver * distToRiver) / 140), t, 0.3);
      a.river.filter.frequency.setTargetAtTime(2500 + 9000 / (1 + distToRiver / 12), t, 0.3);
      a.wind.gain.gain.setTargetAtTime(0.1 + w * 0.17, t, 0.6);
      a.wind.filter.frequency.setTargetAtTime(500 + w * 900, t, 0.6);
      a.leaves.gain.gain.setTargetAtTime((0.05 + w * 0.13) * (0.7 + 0.3 * calm), t, 0.4);
      a.insects.gain.gain.setTargetAtTime(0.045 * calm * calm, t, 1.5);
    }

    // birds sing when it is calm and fall silent in a fire fight; a big bang scatters them
    this.scatterT -= dt;
    if (this.intensity > 0.45 && this.scatterT <= 0) {
      this.scatterT = 25;
      const n = 2 + ((Math.random() * 2) | 0);
      for (let i = 0; i < n; i++) this.later(0.2 + Math.random() * 0.6, () => this.ambient('flap', 10 + Math.random() * 18, 0.4));
    }
    this.birdT -= dt * calm * calm;
    if (this.birdT <= 0) {
      this.birdT = 1.6 + Math.random() * 5;
      const i = (Math.random() * 8) | 0;
      this.ambient(`bird.${i}`, i === 5 || i === 6 ? 35 + Math.random() * 30 : 14 + Math.random() * 35, i === 5 || i === 6 ? 0.3 : 0.22);
    }

    // heartbeat when badly hurt
    if (this.hp > 0 && this.hp < 35) {
      this.heartT -= dt;
      if (this.heartT <= 0) {
        this.heartT = 60 / (72 + (35 - this.hp) * 1.6);
        this.play('heart', this.chain(null, 0, 0, this.ui), t, 0.18 + 0.4 * (1 - this.hp / 35));
      }
    } else this.heartT = 0;
  }

  /** a sound somewhere out in the forest around the listener */
  private ambient(key: string, dist: number, gain: number) {
    if (!this.ctx) return;
    const a = Math.random() * Math.PI * 2;
    const pos = new THREE.Vector3(this.listener.x + Math.sin(a) * dist, this.listener.y + 4 + Math.random() * 8, this.listener.z + Math.cos(a) * dist);
    const P = this.place(pos, 30, 1, false, 70);
    P.delay = 0;
    this.play(key, this.chain(P, 0.3 * gain, 0, this.amb), this.now(), gain, 0.94 + Math.random() * 0.12);
  }
}
