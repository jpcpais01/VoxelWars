import * as THREE from 'three';
import { CHEST_HEIGHT } from '../core/config';
import { angleDiff, clamp, damp } from '../core/noise';
import { newHit } from '../world/World';
import type { Game } from './Game';
import { Input } from './Input';
import { Soldier } from './Soldier';

const hit = newHit();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
export const FP_EYE = 1.58;

/** Turns input into the player soldier's intent and drives the first-person camera. */
export class PlayerController {
  /** view heading (same convention as Soldier.yaw: atan2(dx, dz)) and pitch (up positive) */
  yaw = 0;
  pitch = 0;
  aimPoint = new THREE.Vector3();
  aimTarget: Soldier | null = null;
  spectate: Soldier | null = null;
  readonly eye = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  /** horizontal field of view setting, degrees */
  fov = 90;
  sensitivity = 1;
  /** look motion applied this frame (radians), for viewmodel sway */
  lookYaw = 0;
  lookPitch = 0;
  adsTarget = 0;
  private recoil = 0;
  private recoilV = 0;
  private recoilYaw = 0;
  private bobY = 0;
  private roll = 0;
  private deathPos = new THREE.Vector3();
  private deathCam = new THREE.Vector3();
  private deathInit = false;
  private shakeOff = new THREE.Vector3();

  constructor(public s: Soldier, private input: Input, private game: Game) {
    this.faceEnemyCore();
  }

  faceEnemyCore() {
    const c = this.game.cores[1 - this.s.team].pos;
    this.yaw = Math.atan2(c.x - this.s.pos.x, c.z - this.s.pos.z);
    this.pitch = 0;
    this.deathInit = false;
  }

  /** current optical zoom (1 at the hip) */
  get zoom() {
    const vm = this.game.viewmodel;
    const m = vm.model;
    if (!m) return 1;
    const a = vm.adsAmount;
    return 1 + (m.zoom - 1) * a * a * (3 - 2 * a);
  }

  update(dt: number) {
    const s = this.s;
    const it = s.intent;
    const inp = this.input;
    const g = this.game;

    // ---- look
    const { dx, dy } = inp.takeLook();
    const zoomSlow = 1 / Math.pow(this.zoom, 0.85);
    const k = (inp.touch ? 0.0052 : 0.0022) * this.sensitivity * zoomSlow * (inp.touch && this.aimTarget ? 0.7 : 1);
    this.lookYaw = -dx * k;
    this.lookPitch = -dy * k;
    this.yaw += this.lookYaw;
    this.pitch = clamp(this.pitch + this.lookPitch, -1.45, 1.45);
    if (inp.touch) this.touchAssist(dt);

    // ---- movement relative to the view
    let f = 0, r = 0;
    if (inp.down('KeyW') || inp.down('ArrowUp')) f += 1;
    if (inp.down('KeyS') || inp.down('ArrowDown')) f -= 1;
    if (inp.down('KeyA') || inp.down('ArrowLeft')) r -= 1;
    if (inp.down('KeyD') || inp.down('ArrowRight')) r += 1;
    if (inp.move.active) {
      f = -inp.move.y;
      r = inp.move.x;
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // right of the heading is (-cos, sin)
    it.moveX = sy * f - cy * r;
    it.moveZ = cy * f + sy * r;
    it.sprint = (inp.down('ShiftLeft') || inp.down('ShiftRight') || (inp.move.active && inp.move.y < -0.92)) && f > 0.3;
    it.jump = inp.down('Space') || inp.touchTaps.has('jump');

    it.fire = inp.lmb || inp.touchButtons.has('fire');
    it.ads = inp.rmb || inp.touchButtons.has('ads');
    if (inp.hit('KeyR') || inp.touchTaps.has('reload')) it.reload = true;
    if (inp.hit('Digit1')) it.switchTo = 0;
    if (inp.hit('Digit2')) it.switchTo = 1;
    if (inp.hit('KeyQ') || inp.wheel !== 0 || inp.touchTaps.has('swap')) it.switchTo = 1 - s.current;
    it.useItem = inp.down('KeyG') || inp.down('KeyF') || inp.touchButtons.has('item');
    this.adsTarget = it.ads && !s.sprinting && !s.weapon.reloading && s.switchT <= 0 ? 1 : 0;

    // ---- where the crosshair points
    this.computeView(dt);
    this.aimRay();
    it.aim.copy(this.aimPoint);
    s.yaw = this.yaw;
    s.fpAim.copy(this.forward);
    s.fpEye.copy(this.eye);
    void g;
  }

  /** gentle touch aim assist: slows and nudges toward an enemy close to the crosshair */
  private touchAssist(dt: number) {
    const s = this.s;
    let best: Soldier | null = null;
    let bestA = 0.09;
    for (const e of this.game.soldiers) {
      if (!e.alive || e.team === s.team) continue;
      tmp.set(e.pos.x - this.eye.x, e.pos.y + CHEST_HEIGHT - this.eye.y, e.pos.z - this.eye.z);
      const d = tmp.length();
      if (d > 45 || d < 1) continue;
      const ya = angleDiff(this.yaw, Math.atan2(tmp.x, tmp.z));
      const pa = Math.asin(tmp.y / d) - this.pitch;
      const a = Math.hypot(ya, pa);
      if (a < bestA && this.game.world.lineOfSight(this.eye.x, this.eye.y, this.eye.z, e.pos.x, e.pos.y + CHEST_HEIGHT, e.pos.z)) {
        bestA = a;
        best = e;
      }
    }
    if (!best) return;
    const moving = this.input.look.active || this.s.intent.fire;
    if (!moving) return;
    tmp.set(best.pos.x - this.eye.x, best.pos.y + CHEST_HEIGHT - this.eye.y, best.pos.z - this.eye.z);
    const d = tmp.length();
    const ya = angleDiff(this.yaw, Math.atan2(tmp.x, tmp.z));
    const pa = Math.asin(tmp.y / d) - this.pitch;
    const pull = Math.min(1, dt * 2.2);
    this.yaw += ya * pull;
    this.pitch += pa * pull;
  }

  /** recoil kick for the player's own shots */
  onShot() {
    const st = this.s.weapon.stats;
    const ads = this.game.viewmodel.adsAmount;
    const kick = st.recoil * (1.15 - 0.4 * ads) * (this.s.weapon.def.model.bulky ? 1.15 : 1);
    this.recoilV += kick * 26;
    this.recoilYaw += (Math.random() - 0.5) * kick * 0.6;
    // part of every kick stays: the player pulls it back down
    this.pitch = clamp(this.pitch + kick * 0.35, -1.45, 1.45);
  }

  private computeView(dt: number) {
    const s = this.s;
    // recoil spring on top of the aim
    this.recoilV += (-140 * this.recoil - 18 * this.recoilV) * dt;
    this.recoil += this.recoilV * dt;
    this.recoilYaw = damp(this.recoilYaw, 0, 8, dt);
    // head bob and strafe roll (kept small; most motion lives in the viewmodel)
    const hs = Math.hypot(s.vel.x, s.vel.z);
    const ads = this.game.viewmodel.adsAmount;
    const bobAmp = clamp(hs / 6, 0, 1) * (s.onGround ? 1 : 0) * (1 - ads * 0.8);
    this.bobY = damp(this.bobY, Math.abs(Math.sin(s.walkPhase)) * 0.045 * bobAmp - 0.02 * bobAmp, 14, dt);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const side = s.vel.x * -cy + s.vel.z * sy;
    this.roll = damp(this.roll, -side * 0.0035, 6, dt);
    const pitch = this.pitch + this.recoil;
    const yaw = this.yaw + this.recoilYaw;
    this.eye.set(s.pos.x, s.visualY + FP_EYE + this.bobY, s.pos.z);
    this.forward.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  }

  private aimRay() {
    const g = this.game;
    const o = this.eye, d = this.forward;
    let best = 300;
    this.aimTarget = null;
    for (const e of g.soldiers) {
      if (!e.alive || e === this.s) continue;
      const t = rayCylinder(o, d, e.pos.x, e.pos.y, e.pos.z, 0.42, 1.85);
      if (t > 0 && t < best) {
        best = t;
        this.aimTarget = e;
      }
    }
    for (const c of g.cores) {
      if (!c.alive) continue;
      const t = rayCylinder(o, d, c.pos.x, c.pos.y, c.pos.z, c.radius, c.height);
      if (t > 0 && t < best) {
        best = t;
        this.aimTarget = null;
      }
    }
    if (g.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, best, hit) && hit.dist < best) {
      best = hit.dist;
      this.aimTarget = null;
    }
    this.aimPoint.copy(o).addScaledVector(d, best);
  }

  updateCamera(dt: number) {
    const g = this.game;
    const cam = g.renderer.camera;
    const s = this.s;
    // field of view: the setting is horizontal at 16:9, clamped for tall screens
    const base = THREE.MathUtils.degToRad(this.fov);
    let v = 2 * Math.atan(Math.tan(base / 2) / (16 / 9));
    const minH = THREE.MathUtils.degToRad(62);
    const hNow = 2 * Math.atan(Math.tan(v / 2) * cam.aspect);
    if (hNow < minH) v = 2 * Math.atan(Math.tan(minH / 2) / cam.aspect);
    const fovDeg = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(v / 2) / this.zoom));
    if (Math.abs(cam.fov - fovDeg) > 0.01) {
      cam.fov = fovDeg;
      cam.updateProjectionMatrix();
    }
    // camera shake (rotation only)
    const sh = g.renderer.shake;
    if (sh > 0.001) {
      this.shakeOff.set((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, 0).multiplyScalar(0.06);
      g.renderer.shake = Math.max(0, sh - dt * 3 * Math.max(1, sh));
    } else this.shakeOff.set(0, 0, 0);

    if (s.alive) {
      this.deathInit = false;
      this.computeView(0);
      cam.position.copy(this.eye);
      cam.rotation.set(this.pitch + this.recoil + this.shakeOff.x, this.yaw + this.recoilYaw + Math.PI + this.shakeOff.y, this.roll, 'YXZ');
      return;
    }
    // death cam: rise above the body and watch whoever took us out
    if (!this.deathInit) {
      this.deathInit = true;
      this.deathPos.set(s.pos.x, s.pos.y, s.pos.z);
      this.deathCam.copy(cam.position);
    }
    const killer = this.spectate && this.spectate.alive ? this.spectate : null;
    const look = killer ? tmp.set(killer.pos.x, killer.pos.y + 1.2, killer.pos.z) : tmp.set(this.deathPos.x + Math.sin(this.yaw) * 4, this.deathPos.y + 0.4, this.deathPos.z + Math.cos(this.yaw) * 4);
    const away = tmp2.set(this.deathPos.x - look.x, 0, this.deathPos.z - look.z);
    if (away.lengthSq() < 0.01) away.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    away.normalize();
    const want = tmp2.set(this.deathPos.x + away.x * 3.2, this.deathPos.y + 3.4, this.deathPos.z + away.z * 3.2);
    this.deathCam.x = damp(this.deathCam.x, want.x, 2.5, dt);
    this.deathCam.y = damp(this.deathCam.y, want.y, 2.5, dt);
    this.deathCam.z = damp(this.deathCam.z, want.z, 2.5, dt);
    cam.position.copy(this.deathCam);
    cam.lookAt(look);
  }
}

export function rayCylinder(o: THREE.Vector3, d: THREE.Vector3, cx: number, cy: number, cz: number, r: number, h: number) {
  const px = o.x - cx, pz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-8) return -1;
  const b = 2 * (px * d.x + pz * d.z);
  const c = px * px + pz * pz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t < 0) continue;
    const y = o.y + d.y * t;
    if (y >= cy && y <= cy + h) return t;
  }
  // top cap
  if (d.y < 0) {
    const t = (cy + h - o.y) / d.y;
    const x = o.x + d.x * t - cx, z = o.z + d.z * t - cz;
    if (t > 0 && x * x + z * z < r * r) return t;
  }
  return -1;
}
