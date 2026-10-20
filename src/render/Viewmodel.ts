import * as THREE from 'three';
import { clamp, damp } from '../core/noise';
import { GunModel, gunModel, handModels, PartName } from '../game/gunVoxels';
import type { Soldier } from '../game/Soldier';
import { createGunMaterial } from './gunMaterial';

const gunMat = createGunMaterial();

function flashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,220,150,0.95)');
  grd.addColorStop(0.45, 'rgba(255,140,40,0.35)');
  grd.addColorStop(1, 'rgba(255,90,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  // star spikes
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 5; i++) {
    g.save();
    g.translate(64, 64);
    g.rotate((i / 5) * Math.PI * 2 + 0.3);
    const s = g.createLinearGradient(0, 0, 60, 0);
    s.addColorStop(0, 'rgba(255,230,170,0.9)');
    s.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = s;
    g.beginPath();
    g.moveTo(0, -5);
    g.lineTo(62, 0);
    g.lineTo(0, 5);
    g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Reflex window for red dots and holo sights: faintly tinted glass with a collimated reticle.
 * The reticle is drawn at infinity along the sight axis (+Z in gun space): each fragment works
 * out the angle between the eye's ray and the axis, so the dot stays pinned to where the gun
 * points, only shows when the eye looks down the window, and stays razor sharp at any size
 * (analytic shapes, anti-aliased with screen derivatives).
 */
function lensMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uEye: { value: new THREE.Vector3() },
      uHalf: { value: new THREE.Vector2(0.01, 0.01) },
      uRound: { value: 0.01 },
      uHolo: { value: 0 },
      uColor: { value: new THREE.Color(7, 0.45, 0.3) },
      uTint: { value: new THREE.Color(0.3, 0.55, 0.65) },
    },
    vertexShader: /* glsl */ `
varying vec3 vP;
void main() {
  vP = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uEye;
uniform vec2 uHalf;
uniform float uRound;
uniform float uHolo;
uniform vec3 uColor;
uniform vec3 uTint;
varying vec3 vP;
float line(float d, float w, float px) { return 1.0 - smoothstep(w - px, w + px, d); }
void main() {
  // window shape: rounded rectangle (a circle when the rounding is the half size)
  vec2 q = abs(vP.xy) - uHalf + uRound;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRound;
  float aw = fwidth(sd);
  float win = 1.0 - smoothstep(-aw, aw, sd);
  if (win <= 0.0) discard;
  // angle off the sight axis, in radians (tangent plane)
  vec3 d = vP - uEye;
  vec2 a = d.xy / max(d.z, 1e-4);
  float px = max(length(fwidth(a)) * 0.6, 1e-6);
  float r = length(a);
  float ret, halo;
  if (uHolo > 0.5) {
    // 65 MOA ring with four inner ticks around a 1 MOA dot
    float R = 0.0165, w = max(0.0006, px * 0.8);
    ret = line(abs(r - R), w, px);
    vec2 aa = abs(a);
    float tick = max(line(aa.x, w, px) * step(R * 0.74, aa.y) * step(aa.y, R), line(aa.y, w, px) * step(R * 0.74, aa.x) * step(aa.x, R));
    ret = max(max(ret, tick), line(r, max(0.0011, px * 1.2), px));
    halo = exp(-r * r / 0.0000006) * 0.25;
  } else {
    float R = max(0.0017, px * 1.4);
    ret = line(r, R, px);
    halo = exp(-r * r / (R * R * 7.0)) * 0.35;
  }
  ret *= step(0.0, d.z) * win;
  halo *= step(0.0, d.z) * win;
  // glass: a whisper of tint, darker toward the rim of the window
  float rim = smoothstep(-0.006, 0.0, sd);
  float ga = (0.05 + 0.1 * rim) * win;
  vec3 glass = uTint * (0.2 + 0.2 * rim);
  // premultiplied: the reticle core covers what is behind it, the halo only adds light
  gl_FragColor = vec4(glass * ga + uColor * (ret + halo), ga + (1.0 - ga) * ret);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

export interface ViewLight {
  /** sun direction in view space (towards the sun) */
  sunView: THREE.Vector3;
  upView: THREE.Vector3;
  sunColor: THREE.Color;
  sunI: number;
  sky: THREE.Color;
  ground: THREE.Color;
  hemiI: number;
  /** 0 in full shade, 1 in sunlight */
  sunVis: number;
  /** open-sky visibility at the eye */
  skyVis: number;
}

class Spring {
  x = 0;
  v = 0;
  constructor(private k: number, private c: number) {}
  step(dt: number) {
    const n = Math.min(4, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * this.x - this.c * this.v) * h;
      this.x += this.v * h;
    }
  }
}

/**
 * First-person weapon: its own scene and camera drawn over the world (depth cleared) so the
 * gun never clips into walls and keeps a constant field of view. Handles the pose blend
 * between hip and sights, walk bob, look sway, recoil springs, reloads, swaps, sprinting,
 * muzzle flash, collimated red-dot / holo reticles and lighting matched to where the player stands.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(52, 1, 0.01, 6);
  visible = true;
  private pose = new THREE.Group();
  private gun = new THREE.Group();
  private parts = new Map<PartName, THREE.Mesh>();
  private armR: THREE.Mesh | null = null;
  private armL = new THREE.Group();
  private armLMesh: THREE.Mesh | null = null;
  private flash = new THREE.Group();
  private flashMat: THREE.MeshBasicMaterial;
  private flashLight = new THREE.PointLight(0xffb060, 0, 2.5, 2);
  private lens: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private sun = new THREE.DirectionalLight(0xffffff, 2);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  model: GunModel | null = null;
  private key = '';

  // animation state
  private ads = 0;
  private sprint = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private recoilZ = new Spring(320, 24);
  private recoilP = new Spring(260, 20);
  private flashT = 0;
  private cycleT = 1;
  private cycleDur = 0.5;
  private rotor = 0;
  private cyl = 0;
  private cylTarget = 0;
  private landY = 0;
  private lastSwitchT = 0;

  constructor() {
    this.scene.add(this.pose, this.sun, this.sun.target, this.hemi);
    this.pose.add(this.gun);
    this.gun.rotation.y = Math.PI;
    this.gun.add(this.armL, this.flash);
    this.flashMat = new THREE.MeshBasicMaterial({ map: flashTexture(), color: new THREE.Color(5, 3.6, 2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const quad = new THREE.PlaneGeometry(1, 1);
    const front = new THREE.Mesh(quad, this.flashMat);
    front.scale.setScalar(0.16);
    const side1 = new THREE.Mesh(quad, this.flashMat);
    side1.rotation.y = Math.PI / 2;
    side1.scale.set(0.3, 0.1, 1);
    side1.position.z = 0.1;
    const side2 = side1.clone();
    side2.rotation.z = Math.PI / 2;
    this.flash.add(front, side1, side2, this.flashLight);
    this.flash.visible = false;
    this.flash.renderOrder = 10;

    this.lens = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lensMaterial());
    this.lens.renderOrder = 11;
    this.lens.frustumCulled = false;
    this.gun.add(this.lens);
  }

  setWeapon(s: Soldier) {
    const w = s.weapon;
    const model = gunModel(w.def, w.build);
    const key = `${model.key}|${s.team}`;
    if (key === this.key) return;
    this.key = key;
    this.model = model;
    for (const m of this.parts.values()) this.gun.remove(m);
    this.parts.clear();
    for (const p of model.parts) {
      const mesh = new THREE.Mesh(p.geo, gunMat);
      mesh.position.copy(p.pivot);
      mesh.frustumCulled = false;
      this.gun.add(mesh);
      this.parts.set(p.name, mesh);
    }
    const hands = handModels(model, s.team);
    if (this.armR) this.gun.remove(this.armR);
    this.armR = new THREE.Mesh(hands.right, gunMat);
    this.armR.position.copy(model.gripR);
    this.armR.frustumCulled = false;
    this.gun.add(this.armR);
    if (this.armLMesh) this.armL.remove(this.armLMesh);
    this.armLMesh = new THREE.Mesh(hands.left, gunMat);
    this.armLMesh.frustumCulled = false;
    this.armL.add(this.armLMesh);
    this.armL.position.copy(model.gripL);
    this.flash.position.copy(model.muzzle);
    const big = w.def.model.bulky ? 1.5 : 1;
    this.flash.scale.setScalar(big * (w.stats.suppressed ? 0.35 : 1));
    // reflex window: sized to the sight's opening, the reticle drawn in the shader
    if (model.reticle) {
      const u = this.lens.material.uniforms;
      const h = model.lensHalf;
      this.lens.geometry.dispose();
      this.lens.geometry = new THREE.PlaneGeometry(h.x * 2 + 0.002, h.y * 2 + 0.002);
      this.lens.position.copy(model.lens);
      u.uHalf.value.copy(h);
      u.uRound.value = model.lensRound;
      u.uHolo.value = model.reticle === 'holo' ? 1 : 0;
      u.uColor.value.set(model.reticle === 'dot' ? 0xff2a1c : 0xff3a24).multiplyScalar(model.reticle === 'dot' ? 6 : 4.5);
    }
    this.lens.visible = !!model.reticle;
    this.cycleT = 1;
  }

  onShot(s: Soldier) {
    const st = s.weapon.stats;
    const k = clamp(0.01 + st.recoil * 0.55, 0.012, 0.07) * (1 - this.ads * 0.45);
    this.recoilZ.v += k * 28;
    this.recoilP.v += k * 11 * (0.8 + Math.random() * 0.4);
    this.swayYaw += (Math.random() - 0.5) * k * 0.6;
    this.flashT = st.suppressed ? 0.03 : 0.05;
    this.flash.rotation.z = Math.random() * Math.PI * 2;
    const f = 0.8 + Math.random() * 0.5;
    this.flash.children[0].scale.setScalar(0.16 * f);
    // manual actions cycle between shots
    const id = s.weapon.def.id;
    if (id === 'shotgun' || id === 'sniper') {
      this.cycleT = 0;
      this.cycleDur = Math.min(0.75, 60 / st.rpm * 0.9);
    }
    if (id === 'revolver' || id === 'gl') this.cylTarget += Math.PI / 3;
  }

  private aspect = 0;
  private fov = 0;
  private fovTarget = 52;
  private nearTarget = 0.01;
  resize(aspect: number) {
    if (aspect === this.aspect && Math.abs(this.fovTarget - this.fov) < 0.05 && Math.abs(this.nearTarget - this.camera.near) < 0.002) return;
    this.aspect = aspect;
    this.fov = this.fovTarget;
    this.camera.aspect = aspect;
    this.camera.fov = this.fov;
    this.camera.near = this.nearTarget;
    this.camera.updateProjectionMatrix();
    // squeeze the weapon's depth into [0, 0.02] so it always lands in front of the world
    // (no depth clear needed, so post effects still see the world's depth everywhere else)
    const e = this.camera.projectionMatrix.elements;
    const k = 0.02;
    for (const c of [0, 1, 2, 3]) e[c * 4 + 2] = k * e[c * 4 + 2] + (k - 1) * e[c * 4 + 3];
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  update(dt: number, s: Soldier, lookYaw: number, lookPitch: number, adsTarget: number, light: ViewLight) {
    const m = this.model;
    if (!m) return;
    const w = s.weapon;
    const st = w.stats;
    // aim-down-sights blend: heavier guns come up slower
    const adsRate = 1 / (0.1 + m.heft * 0.16 + (m.scoped ? 0.06 : 0));
    this.ads = adsTarget > this.ads ? Math.min(adsTarget, this.ads + dt * adsRate) : Math.max(adsTarget, this.ads - dt * adsRate * 1.4);
    const a = this.ads * this.ads * (3 - 2 * this.ads);
    this.sprint = damp(this.sprint, s.sprinting ? 1 : 0, 9, dt);

    // look sway (lags behind the camera) and landing bounce
    const vx = lookYaw / Math.max(dt, 1e-3), vy = lookPitch / Math.max(dt, 1e-3);
    this.swayYaw = damp(this.swayYaw, clamp(vx * 0.012, -0.07, 0.07), 9, dt);
    this.swayPitch = damp(this.swayPitch, clamp(vy * 0.01, -0.05, 0.05), 9, dt);
    this.landY = damp(this.landY, clamp(-s.vel.y * 0.0035, -0.035, 0.03), 12, dt);
    this.recoilZ.step(dt);
    this.recoilP.step(dt);

    const hs = Math.hypot(s.vel.x, s.vel.z);
    const amp = clamp(hs / 5, 0, 1.3) * (1 - 0.85 * a) * (s.onGround ? 1 : 0.2);
    const ph = s.walkPhase;
    const sk = 1 + this.sprint * 0.9;

    // hip and sight poses (gun space is turned 180 degrees, so view x = pose.x - gun x)
    // sights sit further from the eye under a narrower lens: same sight size on screen, but the
    // receiver and stock flatten out instead of looming as giant blocks under the reticle
    const relief = m.scoped ? 0.07 : m.reticle ? 0.36 : 0.27;
    this.fovTarget = 52 - (m.scoped ? 0 : 52 * 0.34 * a);
    // with the cheek on the stock, everything behind the rear sight sits under the eye: clip it
    // away so the picture is just the sights and the target
    this.nearTarget = 0.01 + (m.scoped ? 0 : (relief - 0.045) * a * a);
    const hip = { x: 0.118, y: -0.105 - m.sight.y, z: -0.345 + Math.min(0, m.sight.z * 0.3) };
    const sight = { x: m.sight.x, y: -m.sight.y, z: m.sight.z - relief };
    let px = hip.x + (sight.x - hip.x) * a;
    let py = hip.y + (sight.y - hip.y) * a;
    let pz = hip.z + (sight.z - hip.z) * a;
    let rx = 0, ry = 0.035 * (1 - a), rz = -0.06 * (1 - a);

    // walk bob
    px += Math.sin(ph) * 0.007 * amp * sk;
    py -= Math.abs(Math.cos(ph)) * 0.009 * amp * sk;
    rz += Math.sin(ph) * 0.014 * amp;
    // idle breathing
    const t = performance.now() / 1000;
    py += Math.sin(t * 1.6) * 0.0018 * (1 - a * 0.7);
    rx += Math.sin(t * 1.1) * 0.003 * (1 - a * 0.8);
    // sprint carry
    px -= 0.035 * this.sprint;
    py -= 0.04 * this.sprint;
    pz += 0.02 * this.sprint;
    rx -= 0.32 * this.sprint;
    ry += 0.6 * this.sprint;
    rz += 0.25 * this.sprint;
    // sway
    const sw = 1 - 0.75 * a;
    ry += this.swayYaw * sw;
    rx += this.swayPitch * sw;
    px += this.swayYaw * 0.06 * sw;
    py += this.swayPitch * 0.05 * sw + this.landY;
    // recoil
    pz += this.recoilZ.x;
    rx += this.recoilP.x;
    py += this.recoilP.x * 0.04;

    // reload: dip and roll the gun, swap the magazine with the off hand
    const reloading = w.reloading;
    const rt = reloading ? 1 - w.reloadT / st.reload : 0;
    const env = reloading ? smooth(0, 0.14, rt) * (1 - smooth(0.84, 1, rt)) : 0;
    rx -= 0.28 * env;
    rz += 0.45 * env;
    py -= 0.035 * env;
    px -= 0.02 * env;
    const mag = this.parts.get('mag');
    let magY = 0;
    if (mag) {
      if (reloading) {
        if (rt < 0.15) magY = 0;
        else if (rt < 0.38) magY = -0.3 * smooth(0.15, 0.38, rt);
        else if (rt < 0.55) magY = -0.3;
        else if (rt < 0.8) magY = -0.3 * (1 - smooth(0.55, 0.8, rt));
      }
      mag.position.set(m.magAt.x, m.magAt.y + magY, m.magAt.z - magY * 0.15);
      mag.visible = magY > -0.29;
    }
    // off hand follows the magazine during reloads
    const handToMag = reloading ? smooth(0.08, 0.2, rt) * (1 - smooth(0.78, 0.92, rt)) : 0;
    const tgt = new THREE.Vector3().copy(m.magAt).add(new THREE.Vector3(0.03, -0.04 + Math.min(0, magY), 0));
    this.armL.position.copy(m.gripL).lerp(tgt, handToMag);

    // weapon swap: lower out of view and back up
    if (s.switchT > 0) {
      const k = s.switchT / 0.35;
      py -= 0.22 * k;
      rx -= 0.6 * k;
    }
    if (s.switchT > this.lastSwitchT + 0.1) this.cycleT = 1;
    this.lastSwitchT = s.switchT;

    // bolt / pump cycling
    if (this.cycleT < 1) {
      this.cycleT = Math.min(1, this.cycleT + dt / this.cycleDur);
      const c = Math.sin(Math.min(1, this.cycleT * 1.15) * Math.PI);
      const pump = this.parts.get('pump');
      if (pump) pump.position.z = -0.07 * c;
      if (w.def.id === 'shotgun') this.armL.position.z -= 0.07 * c;
      else {
        rz += 0.18 * c;
        py -= 0.012 * c;
      }
    }
    // spinning parts
    const rotor = this.parts.get('rotor');
    if (rotor) {
      this.rotor += dt * w.spin * 38;
      rotor.rotation.z = this.rotor;
    }
    const cyl = this.parts.get('cyl');
    if (cyl) {
      this.cyl = damp(this.cyl, this.cylTarget, 18, dt);
      cyl.rotation.z = this.cyl;
    }
    const war = this.parts.get('warhead');
    if (war) war.visible = w.ammo > 0 || (reloading && rt > 0.62);
    if (war && reloading) war.position.z = rt > 0.62 ? 0.25 * (1 - smooth(0.62, 0.85, rt)) : 0;

    this.pose.position.set(px, py, pz);
    this.pose.rotation.set(rx, ry, rz, 'YXZ');
    if (this.lens.visible) {
      // the eye (camera origin) in the lens's own frame, for the collimated reticle
      this.pose.updateMatrixWorld(true);
      this.lens.material.uniforms.uEye.value.set(0, 0, 0).applyMatrix4(tmpM.copy(this.lens.matrixWorld).invert());
    }

    // flash
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    this.flashLight.intensity = this.flashT > 0 ? 6 : 0;

    // high-power optics hand over to the scope overlay once fully up
    this.pose.visible = !(m.scoped && this.ads > 0.92);

    // lighting matched to the player's surroundings
    this.sun.position.copy(light.sunView).multiplyScalar(4);
    this.sun.color.copy(light.sunColor);
    this.sun.intensity = light.sunI * (0.22 + 0.78 * light.sunVis);
    this.hemi.position.copy(light.upView);
    this.hemi.color.copy(light.sky);
    this.hemi.groundColor.copy(light.ground);
    this.hemi.intensity = light.hemiI * (0.62 + 0.38 * light.skyVis) * 1.3;
  }

  /** how far the sights are up, 0..1 */
  get adsAmount() {
    return this.ads;
  }

  get scopedIn() {
    return !!this.model?.scoped && this.ads > 0.92;
  }
}

const tmpM = new THREE.Matrix4();

function smooth(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
