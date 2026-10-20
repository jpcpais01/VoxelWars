import * as THREE from 'three';
import { CHEST_HEIGHT } from '../core/config';
import { clamp, damp } from '../core/noise';
import { newHit } from '../world/World';
import type { Game } from './Game';
import { Input } from './Input';
import { Soldier } from './Soldier';

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const hit = newHit();

/** Turns input into the player soldier's intent and drives the camera. */
export class PlayerController {
  focus = new THREE.Vector3();
  zoom = 1;
  aimPoint = new THREE.Vector3();
  aimTarget: Soldier | null = null;
  private camVel = new THREE.Vector3();
  private shakeOff = new THREE.Vector3();
  touchAim = new THREE.Vector2(0, -1);
  spectate: Soldier | null = null;

  constructor(public s: Soldier, private input: Input, private game: Game) {
    this.focus.copy(s.pos);
  }

  update(dt: number) {
    const s = this.s;
    const it = s.intent;
    const inp = this.input;
    const g = this.game;
    // ---- movement (camera looks north, -Z is up the screen)
    let mx = 0, mz = 0;
    if (inp.down('KeyW') || inp.down('ArrowUp')) mz -= 1;
    if (inp.down('KeyS') || inp.down('ArrowDown')) mz += 1;
    if (inp.down('KeyA') || inp.down('ArrowLeft')) mx -= 1;
    if (inp.down('KeyD') || inp.down('ArrowRight')) mx += 1;
    if (inp.move.active) {
      mx = inp.move.x;
      mz = inp.move.y;
    }
    it.moveX = mx;
    it.moveZ = mz;
    it.sprint = inp.down('ShiftLeft') || inp.down('ShiftRight') || (inp.move.active && Math.hypot(inp.move.x, inp.move.y) > 0.97 && !inp.look.active);
    it.jump = inp.down('Space') || inp.touchTaps.has('jump');

    // ---- aiming
    if (inp.touch && (inp.look.active || inp.move.active || !inp.lmb)) {
      this.touchAimUpdate(dt);
    } else this.mouseAim();
    it.aim.copy(this.aimPoint);
    it.fire = inp.lmb || (inp.look.active && Math.hypot(inp.look.x, inp.look.y) > 0.55) || inp.touchButtons.has('fire');
    it.ads = inp.rmb || inp.touchButtons.has('ads');

    if (inp.hit('KeyR') || inp.touchTaps.has('reload')) it.reload = true;
    if (inp.hit('Digit1')) it.switchTo = 0;
    if (inp.hit('Digit2')) it.switchTo = 1;
    if (inp.hit('KeyQ') || inp.wheel !== 0 || inp.touchTaps.has('swap')) it.switchTo = 1 - s.current;
    it.useItem = inp.down('KeyG') || inp.down('KeyF') || inp.touchButtons.has('item');
    if (inp.hit('Equal') || inp.hit('NumpadAdd')) this.zoom = clamp(this.zoom - 0.1, 0.7, 1.4);
    if (inp.hit('Minus') || inp.hit('NumpadSubtract')) this.zoom = clamp(this.zoom + 0.1, 0.7, 1.4);
  }

  private mouseAim() {
    const g = this.game;
    const cam = g.renderer.camera;
    const rect = g.renderer.canvas.getBoundingClientRect();
    ndc.set(((this.input.mouseX - rect.left) / rect.width) * 2 - 1, -((this.input.mouseY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const o = ray.ray.origin, d = ray.ray.direction;
    let best = 400;
    let bestPoint: THREE.Vector3 | null = null;
    this.aimTarget = null;
    // soldiers (generous cylinders)
    for (const e of g.soldiers) {
      if (!e.alive || e === this.s) continue;
      const t = rayCylinder(o, d, e.pos.x, e.pos.y, e.pos.z, 0.55, 1.9);
      if (t > 0 && t < best) {
        best = t;
        bestPoint = new THREE.Vector3(e.pos.x, e.pos.y + CHEST_HEIGHT, e.pos.z);
        this.aimTarget = e;
      }
    }
    for (const c of g.cores) {
      if (!c.alive) continue;
      const t = rayCylinder(o, d, c.pos.x, c.pos.y, c.pos.z, c.radius, c.height);
      if (t > 0 && t < best) {
        best = t;
        bestPoint = new THREE.Vector3(c.pos.x, c.pos.y + 1.6, c.pos.z);
      }
    }
    if (!bestPoint) {
      // voxels, skipping foliage high above the player so we can aim through canopies
      let ox = o.x, oy = o.y, oz = o.z;
      let travelled = 0;
      for (let i = 0; i < 6; i++) {
        if (!g.world.raycast(ox, oy, oz, d.x, d.y, d.z, 400 - travelled, hit)) break;
        const leafy = hit.mat >= 12 && hit.mat <= 16;
        const high = hit.py > this.s.pos.y + 2.2;
        if (high && (leafy || g.isCutAway(hit.px, hit.py, hit.pz))) {
          ox = hit.px + d.x * 0.05;
          oy = hit.py + d.y * 0.05;
          oz = hit.pz + d.z * 0.05;
          travelled += hit.dist;
          continue;
        }
        bestPoint = new THREE.Vector3(hit.px, hit.py, hit.pz);
        if (hit.ny > 0.5) bestPoint.y += CHEST_HEIGHT; // aim at a person standing there
        break;
      }
    }
    if (!bestPoint) {
      // ground plane fallback
      const t = (this.s.pos.y - o.y) / d.y;
      bestPoint = new THREE.Vector3(o.x + d.x * t, this.s.pos.y + CHEST_HEIGHT, o.z + d.z * t);
    }
    this.aimPoint.copy(bestPoint);
  }

  private touchAimUpdate(dt: number) {
    const s = this.s;
    const look = this.input.look;
    const mv = this.input.move;
    if (look.active && Math.hypot(look.x, look.y) > 0.15) this.touchAim.set(look.x, look.y).normalize();
    else if (mv.active && Math.hypot(mv.x, mv.y) > 0.3 && !look.active) this.touchAim.set(mv.x, mv.y).normalize();
    // aim assist: snap toward the nearest visible enemy in the aim cone
    let dist = 14;
    let ax = this.touchAim.x, az = this.touchAim.y;
    let bestDot = Math.cos(0.32);
    this.aimTarget = null;
    for (const e of this.game.soldiers) {
      if (!e.alive || e.team === s.team) continue;
      const dx = e.pos.x - s.pos.x, dz = e.pos.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 36) continue;
      const dot = (dx * this.touchAim.x + dz * this.touchAim.y) / d;
      if (dot > bestDot && this.game.world.lineOfSight(s.pos.x, s.eyeY, s.pos.z, e.pos.x, e.pos.y + CHEST_HEIGHT, e.pos.z)) {
        bestDot = dot;
        this.aimTarget = e;
        dist = d;
        ax = dx / d;
        az = dz / d;
      }
    }
    const ty = this.aimTarget ? this.aimTarget.pos.y + CHEST_HEIGHT : s.pos.y + CHEST_HEIGHT;
    this.aimPoint.set(s.pos.x + ax * dist, ty, s.pos.z + az * dist);
    void dt;
  }

  updateCamera(dt: number) {
    const g = this.game;
    const cam = g.renderer.camera;
    const tgt = this.spectate && !this.s.alive ? this.spectate : this.s;
    const w = this.s.weapon.stats;
    // look ahead toward the aim, more when aiming down sights
    const ax = this.aimPoint.x - tgt.pos.x, az = this.aimPoint.z - tgt.pos.z;
    const al = Math.hypot(ax, az) + 1e-4;
    let lead = Math.min(al * 0.22, 4.5);
    if (this.s.ads && this.s.alive) lead = Math.min(al, w.adsZoom + 3);
    const fx = tgt.pos.x + (ax / al) * lead;
    const fz = tgt.pos.z + (az / al) * lead * 0.85;
    const k = this.s.ads ? 5 : 7;
    this.focus.x = damp(this.focus.x, fx, k, dt);
    this.focus.z = damp(this.focus.z, fz, k, dt);
    this.focus.y = damp(this.focus.y, tgt.pos.y, 5, dt);
    this.focus.x = clamp(this.focus.x, 12, g.mapW - 12);
    this.focus.z = clamp(this.focus.z, 10, g.mapD - 6);
    const zoom = this.zoom * (this.s.ads && this.s.alive ? 1 + Math.min(0.35, w.adsZoom * 0.012) : 1);
    const off = new THREE.Vector3(0, 27, 12.5).multiplyScalar(zoom);
    // camera shake
    const sh = g.renderer.shake;
    if (sh > 0.001) {
      this.shakeOff.set((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
      g.renderer.shake = Math.max(0, sh - dt * 3 * Math.max(1, sh));
    } else this.shakeOff.set(0, 0, 0);
    cam.position.copy(this.focus).add(off).add(this.shakeOff);
    cam.lookAt(this.focus.x + this.shakeOff.x * 0.5, this.focus.y + this.shakeOff.y * 0.5, this.focus.z);
    void this.camVel;
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
