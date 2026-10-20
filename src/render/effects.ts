import * as THREE from 'three';
import { World } from '../world/World';
import { shared } from './shaderlib';

// ---------------------------------------------------------------------------------------------
// Billboard particles (smoke, fire, sparks, tracers). One draw call per blend mode.

export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  size: number;
  grow?: number;
  life: number;
  r: number;
  g: number;
  b: number;
  a?: number;
  gravity?: number;
  drag?: number;
  stretch?: number; // velocity stretch factor (tracers / sparks)
  fadeIn?: number;
  /** colour fades toward this over life (fire -> smoke) */
  r2?: number;
  g2?: number;
  b2?: number;
  rot?: number;
  spin?: number;
  soft?: number;
}

const PVS = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iVel; // xyz velocity, w stretch
attribute vec4 iCol;
attribute vec3 iSzRot; // size, rotation, softness
varying vec4 vCol;
varying vec2 vUv;
varying float vSoft;
varying float vDepth;
varying float vStretch;
void main() {
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  vec2 q = position.xy;
  float s = iSzRot.x;
  vStretch = 0.0;
  if (iVel.w > 0.0) {
    vec3 ve = (viewMatrix * vec4(iVel.xyz, 0.0)).xyz;
    vec2 dir = ve.xy;
    float len = length(dir);
    if (len > 1e-4) {
      dir /= len;
      vec2 perp = vec2(-dir.y, dir.x);
      float L = max(s, len * iVel.w);
      mv.xy += dir * q.y * L + perp * q.x * s * 0.35;
      vStretch = 1.0;
    }
  } else {
    float c = cos(iSzRot.y), sn = sin(iSzRot.y);
    mv.xy += mat2(c, sn, -sn, c) * q * s;
  }
  vCol = iCol;
  vUv = position.xy + 0.5;
  vSoft = iSzRot.z;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const PFS = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uAdditive;
varying vec4 vCol;
varying vec2 vUv;
varying float vSoft;
varying float vDepth;
varying float vStretch;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a;
  if (vStretch > 0.5) {
    a = (1.0 - smoothstep(0.2, 1.0, abs(p.x))) * (1.0 - smoothstep(0.6, 1.0, abs(p.y)));
  } else {
    a = 1.0 - smoothstep(0.35, 1.0, r);
    // puffy edge
    a *= 0.75 + 0.25 * sin(atan(p.y, p.x) * 5.0 + vCol.a * 10.0) * r;
  }
  float scene = texture2D(tDepth, gl_FragCoord.xy / uResolution).a;
  float soft = clamp((scene - vDepth) / max(vSoft, 0.05), 0.0, 1.0);
  a *= soft * vCol.a;
  if (a < 0.004) discard;
  if (uAdditive > 0.5) gl_FragColor = vec4(vCol.rgb * a, 1.0);
  else gl_FragColor = vec4(vCol.rgb, a);
}`;

class ParticleLayer {
  readonly mesh: THREE.Mesh;
  readonly cap: number;
  n = 0;
  // simulation state
  px: Float32Array; py: Float32Array; pz: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  size: Float32Array; grow: Float32Array; life: Float32Array; age: Float32Array;
  r: Float32Array; g: Float32Array; b: Float32Array; a: Float32Array;
  r2: Float32Array; g2: Float32Array; b2: Float32Array;
  grav: Float32Array; drag: Float32Array; stretch: Float32Array; fadeIn: Float32Array;
  rot: Float32Array; spin: Float32Array; soft: Float32Array;
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aSz: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;

  constructor(cap: number, additive: boolean, depthTex: { value: THREE.Texture | null }) {
    this.cap = cap;
    const F = () => new Float32Array(cap);
    this.px = F(); this.py = F(); this.pz = F(); this.vx = F(); this.vy = F(); this.vz = F();
    this.size = F(); this.grow = F(); this.life = F(); this.age = F();
    this.r = F(); this.g = F(); this.b = F(); this.a = F(); this.r2 = F(); this.g2 = F(); this.b2 = F();
    this.grav = F(); this.drag = F(); this.stretch = F(); this.fadeIn = F(); this.rot = F(); this.spin = F(); this.soft = F();
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSz = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.aPos);
    this.geo.setAttribute('iVel', this.aVel);
    this.geo.setAttribute('iCol', this.aCol);
    this.geo.setAttribute('iSzRot', this.aSz);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: PVS,
      fragmentShader: PFS,
      uniforms: { tDepth: depthTex, uResolution: shared.uResolution, uAdditive: { value: additive ? 1 : 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
  }

  spawn(s: ParticleSpec) {
    let i = this.n;
    if (i >= this.cap) {
      // overwrite the oldest-ish slot
      i = (Math.random() * this.cap) | 0;
    } else this.n++;
    this.px[i] = s.x; this.py[i] = s.y; this.pz[i] = s.z;
    this.vx[i] = s.vx ?? 0; this.vy[i] = s.vy ?? 0; this.vz[i] = s.vz ?? 0;
    this.size[i] = s.size; this.grow[i] = s.grow ?? 0; this.life[i] = s.life; this.age[i] = 0;
    this.r[i] = s.r; this.g[i] = s.g; this.b[i] = s.b; this.a[i] = s.a ?? 1;
    this.r2[i] = s.r2 ?? s.r; this.g2[i] = s.g2 ?? s.g; this.b2[i] = s.b2 ?? s.b;
    this.grav[i] = s.gravity ?? 0; this.drag[i] = s.drag ?? 0; this.stretch[i] = s.stretch ?? 0;
    this.fadeIn[i] = s.fadeIn ?? 0.05; this.rot[i] = s.rot ?? Math.random() * 6.28; this.spin[i] = s.spin ?? 0;
    this.soft[i] = s.soft ?? 0.6;
  }

  update(dt: number) {
    let n = this.n;
    const P = this.aPos.array as Float32Array, Vv = this.aVel.array as Float32Array;
    const Cc = this.aCol.array as Float32Array, S = this.aSz.array as Float32Array;
    for (let i = 0; i < n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        n--;
        this.swap(i, n);
        i--;
        continue;
      }
      const dr = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= dr; this.vy[i] = this.vy[i] * dr - this.grav[i] * dt; this.vz[i] *= dr;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      this.size[i] += this.grow[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      const t = this.age[i] / this.life[i];
      const fade = Math.min(1, this.age[i] / Math.max(this.fadeIn[i], 1e-3)) * (1 - t * t);
      P[i * 3] = this.px[i]; P[i * 3 + 1] = this.py[i]; P[i * 3 + 2] = this.pz[i];
      Vv[i * 4] = this.vx[i]; Vv[i * 4 + 1] = this.vy[i]; Vv[i * 4 + 2] = this.vz[i]; Vv[i * 4 + 3] = this.stretch[i];
      const k = Math.min(1, t * 1.6);
      Cc[i * 4] = this.r[i] + (this.r2[i] - this.r[i]) * k;
      Cc[i * 4 + 1] = this.g[i] + (this.g2[i] - this.g[i]) * k;
      Cc[i * 4 + 2] = this.b[i] + (this.b2[i] - this.b[i]) * k;
      Cc[i * 4 + 3] = this.a[i] * fade;
      S[i * 3] = this.size[i]; S[i * 3 + 1] = this.rot[i]; S[i * 3 + 2] = this.soft[i];
    }
    this.n = n;
    this.geo.instanceCount = n;
    this.aPos.needsUpdate = true;
    this.aVel.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSz.needsUpdate = true;
    this.aPos.clearUpdateRanges();
    this.aPos.addUpdateRange(0, n * 3);
    this.aVel.clearUpdateRanges();
    this.aVel.addUpdateRange(0, n * 4);
    this.aCol.clearUpdateRanges();
    this.aCol.addUpdateRange(0, n * 4);
    this.aSz.clearUpdateRanges();
    this.aSz.addUpdateRange(0, n * 3);
  }

  private swap(i: number, j: number) {
    const arrs = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.size, this.grow, this.life, this.age, this.r, this.g, this.b, this.a, this.r2, this.g2, this.b2, this.grav, this.drag, this.stretch, this.fadeIn, this.rot, this.spin, this.soft];
    for (const a of arrs) a[i] = a[j];
  }
}

export class Particles {
  readonly alpha: ParticleLayer;
  readonly add: ParticleLayer;
  readonly depthTex = { value: null as THREE.Texture | null };
  constructor(scene: THREE.Scene) {
    this.alpha = new ParticleLayer(2600, false, this.depthTex);
    this.add = new ParticleLayer(2200, true, this.depthTex);
    scene.add(this.alpha.mesh, this.add.mesh);
  }
  update(dt: number) {
    this.alpha.update(dt);
    this.add.update(dt);
  }

  smoke(x: number, y: number, z: number, size = 1, dark = 0.35, life = 3) {
    const c = dark;
    this.alpha.spawn({
      x, y, z,
      vx: (Math.random() - 0.5) * 0.8, vy: 0.6 + Math.random() * 0.8, vz: (Math.random() - 0.5) * 0.8,
      size: size * (0.6 + Math.random() * 0.5), grow: size * 0.9, life: life * (0.7 + Math.random() * 0.6),
      r: c, g: c, b: c * 1.02, a: 0.55, drag: 0.8, gravity: -0.15, fadeIn: 0.2, spin: (Math.random() - 0.5) * 0.6, soft: 1.2,
    });
  }

  dust(x: number, y: number, z: number, r: number, g: number, b: number, n = 4, spread = 1) {
    for (let i = 0; i < n; i++) {
      this.alpha.spawn({
        x: x + (Math.random() - 0.5) * 0.3 * spread, y, z: z + (Math.random() - 0.5) * 0.3 * spread,
        vx: (Math.random() - 0.5) * 2 * spread, vy: 0.4 + Math.random() * 1.6, vz: (Math.random() - 0.5) * 2 * spread,
        size: 0.35 * spread + Math.random() * 0.3, grow: 0.9 * spread, life: 0.9 + Math.random() * 1.0,
        r, g, b, a: 0.5, drag: 2.5, gravity: 0.6, fadeIn: 0.05, soft: 0.6,
      });
    }
  }

  fire(x: number, y: number, z: number, size = 1) {
    this.add.spawn({
      x, y, z,
      vx: (Math.random() - 0.5) * 3 * size, vy: 1 + Math.random() * 3 * size, vz: (Math.random() - 0.5) * 3 * size,
      size: size * (0.8 + Math.random() * 0.8), grow: size * 1.5, life: 0.35 + Math.random() * 0.35,
      r: 6, g: 3.2, b: 1.1, r2: 1.2, g2: 0.25, b2: 0.05, drag: 3, gravity: -2, fadeIn: 0.02, soft: 0.8,
    });
  }

  sparks(x: number, y: number, z: number, nx: number, ny: number, nz: number, n = 6, hot = 1) {
    for (let i = 0; i < n; i++) {
      const s = 4 + Math.random() * 8;
      this.add.spawn({
        x, y, z,
        vx: (nx + (Math.random() - 0.5) * 1.6) * s, vy: (ny + Math.random() * 0.8) * s, vz: (nz + (Math.random() - 0.5) * 1.6) * s,
        size: 0.05, life: 0.15 + Math.random() * 0.3, r: 5 * hot, g: 3 * hot, b: 1.2 * hot, gravity: 14, drag: 1.5, stretch: 0.03, soft: 0.1,
      });
    }
  }

  /**
   * A blast: white-hot core flash, a fireball that bursts outward and burns down to embers, a hot
   * shock ring, streaking sparks, a ground dust skirt and only a light veil of smoke afterwards.
   * `ground` is the height of the ground under it if close, else NaN; r/g/b tint the dust.
   */
  explosion(x: number, y: number, z: number, radius: number, ground = NaN, r = 0.55, g = 0.47, b = 0.36) {
    const R = radius;
    const rnd = Math.random;
    // core flash
    this.add.spawn({ x, y, z, size: R * 1.2, grow: R * 2.5, life: 0.09, r: 6, g: 5, b: 3.6, fadeIn: 0.001, soft: 1.5 });
    this.add.spawn({ x, y, z, size: R * 0.7, life: 0.16, r: 5, g: 3, b: 1.1, fadeIn: 0.001, soft: 1 });
    // fireball: puffs burst along random directions and stall against drag, burning down to red
    const nf = Math.round(10 + R * 4);
    for (let i = 0; i < nf; i++) {
      const u = rnd() * 2 - 1, a = rnd() * 6.283, h = Math.sqrt(1 - u * u);
      const dx = h * Math.cos(a), dy = Math.abs(u) * 0.8 + 0.2, dz = h * Math.sin(a);
      const sp = R * (3 + rnd() * 4);
      const hot = rnd() < 0.3;
      this.add.spawn({
        x: x + dx * 0.2, y: y + dy * 0.2, z: z + dz * 0.2,
        vx: dx * sp, vy: dy * sp, vz: dz * sp,
        size: R * (0.22 + rnd() * 0.2), grow: R * (0.7 + rnd() * 0.5), life: 0.35 + rnd() * 0.4,
        r: hot ? 3.2 : 2.4, g: hot ? 1.9 : 0.95, b: hot ? 0.7 : 0.22, r2: 0.9, g2: 0.16, b2: 0.03, a: 0.6,
        drag: 6, gravity: -2.5, fadeIn: 0.015, spin: (rnd() - 0.5) * 3, soft: 1,
      });
    }
    // hot shock ring racing out flat across the blast
    const nr = Math.round(14 + R * 3);
    for (let i = 0; i < nr; i++) {
      const a = (i / nr) * 6.283 + rnd() * 0.2;
      const sp = R * 9;
      this.add.spawn({
        x, y: y + 0.1, z,
        vx: Math.cos(a) * sp, vy: 0, vz: Math.sin(a) * sp,
        size: 0.16 + R * 0.05, life: 0.16, r: 6, g: 4.2, b: 2.4, r2: 2, g2: 0.8, b2: 0.3,
        drag: 7, stretch: 0.04, fadeIn: 0.001, soft: 0.3,
      });
    }
    // sparks streak out and arc down; a few slow embers drift on the heat
    const ns = Math.round(R * 7);
    for (let i = 0; i < ns; i++) {
      const a = rnd() * 6.283, up = 0.2 + rnd() * 1.1;
      const sp = 9 + rnd() * 16;
      this.add.spawn({
        x, y, z,
        vx: Math.cos(a) * sp, vy: up * sp, vz: Math.sin(a) * sp,
        size: 0.05 + rnd() * 0.03, life: 0.35 + rnd() * 0.6, r: 7, g: 4, b: 1.4, r2: 3, g2: 0.9, b2: 0.15,
        gravity: 16, drag: 1.2, stretch: 0.035, fadeIn: 0.001, soft: 0.1,
      });
    }
    const ne = Math.round(R * 3);
    for (let i = 0; i < ne; i++) {
      this.add.spawn({
        x: x + (rnd() - 0.5) * R * 0.8, y: y + rnd() * R * 0.4, z: z + (rnd() - 0.5) * R * 0.8,
        vx: (rnd() - 0.5) * 3, vy: 2 + rnd() * 3, vz: (rnd() - 0.5) * 3,
        size: 0.06 + rnd() * 0.05, life: 1 + rnd() * 1.2, r: 4.5, g: 1.8, b: 0.4, r2: 1.2, g2: 0.25, b2: 0.05,
        gravity: 1.2, drag: 1.4, fadeIn: 0.05, soft: 0.1,
      });
    }
    // ground skirt: dust thrown out in a ring hugging the ground
    if (ground === ground) {
      const nd = Math.round(10 + R * 3);
      for (let i = 0; i < nd; i++) {
        const a = (i / nd) * 6.283 + rnd() * 0.3;
        const sp = R * (2.5 + rnd() * 2);
        this.alpha.spawn({
          x: x + Math.cos(a) * 0.3, y: ground + 0.15, z: z + Math.sin(a) * 0.3,
          vx: Math.cos(a) * sp, vy: 0.3 + rnd() * 0.8, vz: Math.sin(a) * sp,
          size: 0.3 + R * 0.1, grow: R * 0.5, life: 0.7 + rnd() * 0.5,
          r, g, b, a: 0.45, drag: 4, gravity: 0.3, fadeIn: 0.03, soft: 0.8,
        });
      }
    }
    // a thin, short veil of smoke that rises once the fire is out
    const nm = Math.round(2 + R * 1.2);
    for (let i = 0; i < nm; i++) {
      this.alpha.spawn({
        x: x + (rnd() - 0.5) * R * 0.5, y: y + 0.3 + rnd() * R * 0.3, z: z + (rnd() - 0.5) * R * 0.5,
        vx: (rnd() - 0.5) * 0.8, vy: 1.2 + rnd() * 1.2, vz: (rnd() - 0.5) * 0.8,
        size: R * (0.35 + rnd() * 0.2), grow: R * 0.45, life: 1.5 + rnd() * 1.1,
        r: 0.34, g: 0.33, b: 0.33, a: 0.32, drag: 0.9, gravity: -0.4, fadeIn: 0.35, spin: (rnd() - 0.5) * 0.5, soft: 1.2,
      });
    }
  }

  muzzle(x: number, y: number, z: number, dx: number, dz: number, scale = 1) {
    this.add.spawn({ x, y, z, size: 0.35 * scale, life: 0.05, r: 9, g: 6, b: 2.5, fadeIn: 0.001, soft: 0.1 });
    this.add.spawn({ x: x + dx * 0.2, y, z: z + dz * 0.2, vx: dx * 6, vz: dz * 6, size: 0.18 * scale, life: 0.06, r: 8, g: 4.5, b: 1.5, stretch: 0.05, fadeIn: 0.001, soft: 0.1 });
    this.alpha.spawn({ x: x + dx * 0.3, y, z: z + dz * 0.3, vx: dx * 1.5, vy: 0.4, vz: dz * 1.5, size: 0.25 * scale, grow: 0.8, life: 0.5, r: 0.7, g: 0.7, b: 0.7, a: 0.25, drag: 3, soft: 0.4 });
  }

  tracer(x: number, y: number, z: number, vx: number, vy: number, vz: number, bright = 1, life = 0.08) {
    this.add.spawn({ x, y, z, vx, vy, vz, size: 0.06, life, r: 6 * bright, g: 4.2 * bright, b: 1.6 * bright, stretch: 0.03, fadeIn: 0.001, soft: 0.2 });
  }

  splash(x: number, y: number, z: number, n = 8, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28;
      const s = (1 + Math.random() * 2) * power;
      this.alpha.spawn({
        x, y, z,
        vx: Math.cos(a) * s, vy: (2.5 + Math.random() * 3) * power, vz: Math.sin(a) * s,
        size: 0.12 + Math.random() * 0.12, grow: 0.3, life: 0.6 + Math.random() * 0.3,
        r: 0.85, g: 0.95, b: 1, a: 0.85, gravity: 12, drag: 0.5, soft: 0.2,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Voxel debris: small lit cubes that tumble, bounce and settle.

export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private cap = 1400;
  n = 0;
  private px: Float32Array; private py: Float32Array; private pz: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private ax: Float32Array; private ay: Float32Array; private az: Float32Array; private ang: Float32Array; private av: Float32Array;
  private sz: Float32Array; private life: Float32Array; private age: Float32Array; private drag: Float32Array; private grav: Float32Array;
  private col: Float32Array;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(private world: World, scene: THREE.Scene) {
    const F = () => new Float32Array(this.cap);
    this.px = F(); this.py = F(); this.pz = F(); this.vx = F(); this.vy = F(); this.vz = F();
    this.ax = F(); this.ay = F(); this.az = F(); this.ang = F(); this.av = F();
    this.sz = F(); this.life = F(); this.age = F(); this.drag = F(); this.grav = F();
    this.col = new Float32Array(this.cap * 3);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, colorLinear: THREE.Color, life = 5, leafy = false) {
    let i = this.n;
    if (i >= this.cap) i = (Math.random() * this.cap) | 0;
    else this.n++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.ax[i] = this.axis.x; this.ay[i] = this.axis.y; this.az[i] = this.axis.z;
    this.ang[i] = Math.random() * 6; this.av[i] = (Math.random() - 0.5) * 18;
    this.sz[i] = size; this.life[i] = life * (0.7 + Math.random() * 0.6); this.age[i] = 0;
    this.drag[i] = leafy ? 2.2 : 0.15; this.grav[i] = leafy ? 3 : 22;
    this.col[i * 3] = colorLinear.r; this.col[i * 3 + 1] = colorLinear.g; this.col[i * 3 + 2] = colorLinear.b;
  }

  update(dt: number) {
    let n = this.n;
    const w = this.world;
    for (let i = 0; i < n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        n--;
        this.copy(n, i);
        i--;
        continue;
      }
      const dr = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= dr; this.vz[i] *= dr; this.vy[i] = this.vy[i] * dr - this.grav[i] * dt;
      const nx = this.px[i] + this.vx[i] * dt;
      const ny = this.py[i] + this.vy[i] * dt;
      const nz = this.pz[i] + this.vz[i] * dt;
      const half = this.sz[i] * 0.5;
      if (w.solidAt(nx, this.py[i], this.pz[i])) this.vx[i] *= -0.35;
      else this.px[i] = nx;
      if (w.solidAt(this.px[i], this.py[i], nz)) this.vz[i] *= -0.35;
      else this.pz[i] = nz;
      if (this.vy[i] < 0 && w.solidAt(this.px[i], ny - half, this.pz[i])) {
        const top = w.groundBelow(this.px[i], ny - half + 0.2, this.pz[i]);
        this.py[i] = top + half;
        this.vy[i] *= -0.28;
        this.vx[i] *= 0.55;
        this.vz[i] *= 0.55;
        this.av[i] *= 0.5;
        if (Math.abs(this.vy[i]) < 0.6) this.vy[i] = 0;
      } else this.py[i] = ny;
      this.ang[i] += this.av[i] * dt;
      const t = this.life[i] - this.age[i];
      const scale = this.sz[i] * Math.min(1, t / 0.6);
      this.axis.set(this.ax[i], this.ay[i], this.az[i]);
      this.q.setFromAxisAngle(this.axis, this.ang[i]);
      this.v.set(this.px[i], this.py[i], this.pz[i]);
      this.s.set(scale, scale, scale);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.c.setRGB(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]);
      this.mesh.setColorAt(i, this.c);
    }
    this.n = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private copy(from: number, to: number) {
    const arrs = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.ax, this.ay, this.az, this.ang, this.av, this.sz, this.life, this.age, this.drag, this.grav];
    for (const a of arrs) a[to] = a[from];
    this.col[to * 3] = this.col[from * 3];
    this.col[to * 3 + 1] = this.col[from * 3 + 1];
    this.col[to * 3 + 2] = this.col[from * 3 + 2];
  }
}
