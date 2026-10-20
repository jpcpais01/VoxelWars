import * as THREE from 'three';

/**
 * Fully procedural WebAudio: gunshots, explosions, impacts, footsteps and a living forest
 * ambience (river, wind, birds). No audio files to download.
 */
export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private amb!: GainNode;
  private comp!: DynamicsCompressorNode;
  private noise!: AudioBuffer;
  private river!: GainNode;
  private wind!: GainNode;
  private windFilter!: BiquadFilterNode;
  listener = new THREE.Vector3();
  /** heading of the listener (atan2(dx, dz)); sounds pan relative to it */
  listenerYaw = Math.PI;
  volume = 0.8;
  private lastTick = 0;
  private recent = new Map<string, number>();
  private birdT = 3;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.sfx = ctx.createGain();
    this.amb = ctx.createGain();
    this.amb.gain.value = 0.55;
    this.sfx.connect(this.comp);
    this.amb.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbience();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private startAmbience() {
    const ctx = this.ctx!;
    const mk = (freq: number, q: number, type: BiquadFilterType) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.amb);
      src.start();
      return { g, f };
    };
    const r = mk(900, 0.4, 'bandpass');
    this.river = r.g;
    const w = mk(400, 0.7, 'lowpass');
    this.wind = w.g;
    this.windFilter = w.f;
  }

  /** distance attenuation + stereo pan relative to the listener */
  private spatial(pos: THREE.Vector3 | null, range: number): { gain: number; pan: number } {
    if (!pos) return { gain: 1, pan: 0 };
    const dx = pos.x - this.listener.x, dz = pos.z - this.listener.z;
    const d = Math.hypot(dx, dz);
    const gain = 1 / (1 + (d * d) / (range * range));
    // right of the heading is (-cos, sin)
    const side = -dx * Math.cos(this.listenerYaw) + dz * Math.sin(this.listenerYaw);
    return { gain, pan: Math.max(-0.85, Math.min(0.85, side / (d + 3))) };
  }

  private out(pos: THREE.Vector3 | null, range: number, vol: number): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const { gain, pan } = this.spatial(pos, range);
    if (gain * vol < 0.01) return null;
    const g = ctx.createGain();
    g.gain.value = gain * vol;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.sfx);
    return g;
  }

  private noiseBurst(dst: AudioNode, t: number, dur: number, f0: number, f1: number, q: number, vol: number, type: BiquadFilterType = 'bandpass') {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dst);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  private tone(dst: AudioNode, t: number, dur: number, f0: number, f1: number, vol: number, type: OscillatorType = 'sine') {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dst);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private limit(key: string, ms: number) {
    const now = performance.now();
    const last = this.recent.get(key) ?? 0;
    if (now - last < ms) return false;
    this.recent.set(key, now);
    return true;
  }

  gunshot(pos: THREE.Vector3, snd: { body: number; crack: number; thump: number; decay: number }, suppressed: boolean, isPlayer: boolean) {
    if (!this.ctx) return;
    if (!isPlayer && !this.limit('gun' + Math.round(pos.x / 4) + Math.round(pos.z / 4), 45)) return;
    const dst = this.out(isPlayer ? null : pos, suppressed ? 9 : 40, isPlayer ? 0.55 : 0.75);
    if (!dst) return;
    const t = this.ctx.currentTime;
    if (suppressed) {
      this.noiseBurst(dst, t, 0.08, 2400, 900, 0.7, 0.5);
      this.tone(dst, t, 0.06, 300, 120, 0.25, 'triangle');
      return;
    }
    const v = 0.9;
    this.noiseBurst(dst, t, 0.045, 4200 * snd.crack, 1800, 0.6, v * snd.crack);
    this.noiseBurst(dst, t, snd.decay, snd.body, 180, 0.9, v * 0.9);
    this.tone(dst, t, snd.decay * 0.8, 140 * snd.thump + 40, 38, v * snd.thump * 0.9, 'sine');
    // distant tail
    this.noiseBurst(dst, t + 0.02, snd.decay * 2.4, 700, 120, 0.4, v * 0.18, 'lowpass');
  }

  explosion(pos: THREE.Vector3, size = 1) {
    if (!this.ctx) return;
    const dst = this.out(pos, 70, 1.1 * Math.min(1.6, size));
    if (!dst) return;
    const t = this.ctx.currentTime;
    this.tone(dst, t, 0.9 * size, 90, 28, 1.0, 'sine');
    this.noiseBurst(dst, t, 0.12, 3000, 600, 0.5, 0.9);
    this.noiseBurst(dst, t, 1.4 * size, 900, 50, 0.6, 0.9, 'lowpass');
    this.noiseBurst(dst, t + 0.05, 2.2 * size, 300, 40, 0.3, 0.35, 'lowpass');
    // debris patter
    for (let i = 0; i < 6; i++) this.noiseBurst(dst, t + 0.3 + Math.random() * 0.9, 0.04, 2500 + Math.random() * 2000, 1500, 2, 0.12);
  }

  impact(pos: THREE.Vector3, kind: string) {
    if (!this.ctx || !this.limit('imp', 28)) return;
    const dst = this.out(pos, 14, 0.4);
    if (!dst) return;
    const t = this.ctx.currentTime;
    switch (kind) {
      case 'metal':
        this.tone(dst, t, 0.18, 2200 + Math.random() * 800, 1800, 0.3, 'triangle');
        this.noiseBurst(dst, t, 0.04, 5000, 3000, 2, 0.3);
        break;
      case 'stone':
      case 'build':
        this.noiseBurst(dst, t, 0.06, 3200, 1200, 1.4, 0.45);
        break;
      case 'wood':
        this.tone(dst, t, 0.07, 420, 200, 0.4, 'triangle');
        this.noiseBurst(dst, t, 0.05, 1400, 600, 1.2, 0.3);
        break;
      case 'leaf':
        this.noiseBurst(dst, t, 0.12, 5000, 2500, 0.6, 0.18);
        break;
      default:
        this.noiseBurst(dst, t, 0.07, 900, 300, 0.8, 0.4);
    }
  }

  flesh(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const dst = this.out(pos, 16, 0.4);
    if (!dst) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(dst, t, 0.06, 700, 250, 1, 0.5);
  }

  hitmarker(kill: boolean) {
    if (!this.ctx) return;
    const dst = this.out(null, 1, kill ? 0.35 : 0.22)!;
    const t = this.ctx.currentTime;
    this.tone(dst, t, 0.05, kill ? 1600 : 2400, kill ? 1200 : 2200, 0.6, 'square');
    if (kill) this.tone(dst, t + 0.06, 0.12, 900, 700, 0.5, 'square');
  }

  foot(pos: THREE.Vector3, vol: number) {
    if (!this.ctx || !this.limit('foot' + Math.round(pos.x) + Math.round(pos.z), 90)) return;
    const dst = this.out(pos, 7, 0.16 * vol);
    if (!dst) return;
    this.noiseBurst(dst, this.ctx.currentTime, 0.05, 800, 300, 1.2, 0.6);
  }

  splash(pos: THREE.Vector3, vol: number) {
    if (!this.ctx || !this.limit('spl', 60)) return;
    const dst = this.out(pos, 12, 0.35 * vol);
    if (!dst) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(dst, t, 0.25, 1800, 500, 0.7, 0.7);
    this.tone(dst, t, 0.12, 600, 1400, 0.15, 'sine');
  }

  reload(pos: THREE.Vector3, isPlayer: boolean) {
    if (!this.ctx) return;
    const dst = this.out(isPlayer ? null : pos, 8, 0.35);
    if (!dst) return;
    const t = this.ctx.currentTime;
    this.tone(dst, t, 0.04, 1800, 1500, 0.4, 'square');
    this.noiseBurst(dst, t + 0.18, 0.05, 2500, 1200, 2, 0.4);
    this.tone(dst, t + 0.35, 0.05, 1200, 900, 0.4, 'square');
  }

  dryFire(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const dst = this.out(pos, 6, 0.3);
    if (!dst) return;
    this.tone(dst, this.ctx.currentTime, 0.03, 3000, 2600, 0.3, 'square');
  }

  creak(pos: THREE.Vector3, tree: boolean) {
    if (!this.ctx) return;
    const dst = this.out(pos, 30, 0.6);
    if (!dst) return;
    const t = this.ctx.currentTime;
    if (tree) {
      for (let i = 0; i < 4; i++) this.tone(dst, t + i * 0.12, 0.18, 180 + Math.random() * 60, 120, 0.35, 'sawtooth');
      this.noiseBurst(dst, t, 1.2, 4000, 2000, 0.5, 0.25);
    } else this.noiseBurst(dst, t, 0.8, 600, 120, 0.5, 0.5, 'lowpass');
  }

  crash(pos: THREE.Vector3, size: number) {
    if (!this.ctx) return;
    const dst = this.out(pos, 40, Math.min(1.2, 0.4 + size / 800));
    if (!dst) return;
    const t = this.ctx.currentTime;
    this.tone(dst, t, 0.5, 70, 30, 0.8, 'sine');
    this.noiseBurst(dst, t, 0.9, 1200, 80, 0.5, 0.8, 'lowpass');
    this.noiseBurst(dst, t, 0.6, 5000, 2000, 0.4, 0.2);
  }

  throwSnd(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const dst = this.out(pos, 8, 0.3);
    if (!dst) return;
    this.noiseBurst(dst, this.ctx.currentTime, 0.18, 800, 2400, 0.8, 0.4);
  }

  beep(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const dst = this.out(pos, 10, 0.25);
    if (!dst) return;
    this.tone(dst, this.ctx.currentTime, 0.06, 2600, 2600, 0.4, 'square');
  }

  uiClick(v = 1) {
    if (!this.ctx) return;
    const dst = this.out(null, 1, 0.18 * v)!;
    const t = this.ctx.currentTime;
    this.tone(dst, t, 0.05, 1200, 900, 0.5, 'triangle');
  }

  alarm() {
    if (!this.ctx || !this.limit('alarm', 3500)) return;
    const dst = this.out(null, 1, 0.22)!;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) this.tone(dst, t + i * 0.22, 0.16, 880, 660, 0.5, 'square');
  }

  fanfare(win: boolean) {
    if (!this.ctx) return;
    const dst = this.out(null, 1, 0.35)!;
    const t = this.ctx.currentTime;
    const notes = win ? [523, 659, 784, 1046] : [392, 349, 311, 262];
    notes.forEach((f, i) => this.tone(dst, t + i * 0.18, 0.5, f, f, 0.5, 'triangle'));
  }

  /** update ambience levels from the listener position */
  updateAmbience(dt: number, distToRiver: number, wind: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rv = 0.32 / (1 + (distToRiver * distToRiver) / 120);
    this.river.gain.setTargetAtTime(rv, t, 0.3);
    this.wind.gain.setTargetAtTime(0.05 + wind * 0.06, t, 0.8);
    this.windFilter.frequency.setTargetAtTime(300 + wind * 400, t, 0.8);
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = 1.5 + Math.random() * 5;
      const dst = this.ctx.createGain();
      dst.gain.value = 0.05 + Math.random() * 0.05;
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.random() * 1.6 - 0.8;
      dst.connect(p).connect(this.amb);
      const base = 2200 + Math.random() * 2200;
      const n = 2 + ((Math.random() * 4) | 0);
      for (let i = 0; i < n; i++) {
        const tt = t + i * (0.09 + Math.random() * 0.06);
        this.tone(dst, tt, 0.07 + Math.random() * 0.05, base * (1 + Math.random() * 0.3), base * (0.7 + Math.random() * 0.5), 0.6, 'sine');
      }
    }
  }
}
