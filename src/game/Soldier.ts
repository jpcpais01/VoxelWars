import * as THREE from 'three';
import { GRAVITY, SOLDIER_HEIGHT, SOLDIER_RADIUS, STEP_HEIGHT, Team, WATER_Y } from '../core/config';
import { angleDiff, clamp, damp } from '../core/noise';
import type { Game } from './Game';
import { SoldierRig, buildSoldier, gunMuzzleZ, setRigGun } from './models';
import { Build, ITEMS, ItemId, Loadout, Stats, WEAPON, WeaponDef, computeStats } from './weapons';

export class WeaponState {
  stats: Stats;
  ammo: number;
  reserve: number;
  reloadT = 0;
  cooldown = 0;
  spin = 0;
  bloom = 0;
  triggerLatch = false;
  constructor(public def: WeaponDef, public build: Build) {
    this.stats = computeStats(def, build);
    this.ammo = this.stats.mag;
    this.reserve = this.stats.mag * this.stats.reserve;
  }
  get reloading() {
    return this.reloadT > 0;
  }
  refill() {
    this.ammo = this.stats.mag;
    this.reserve = this.stats.mag * this.stats.reserve;
    this.reloadT = 0;
  }
}

export interface Intent {
  moveX: number;
  moveZ: number;
  aim: THREE.Vector3;
  fire: boolean;
  ads: boolean;
  sprint: boolean;
  jump: boolean;
  reload: boolean;
  switchTo: number; // -1 none
  useItem: boolean;
}

let NEXT_ID = 1;

export class Soldier {
  readonly id = NEXT_ID++;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  bodyYaw = 0;
  hp = 100;
  alive = true;
  respawnAt = 0;
  protectedUntil = 0;
  onGround = false;
  waterDepth = 0;
  weapons: WeaponState[] = [];
  current = 0;
  item: ItemId = 'frag';
  itemCount = 0;
  intent: Intent = { moveX: 0, moveZ: 0, aim: new THREE.Vector3(), fire: false, ads: false, sprint: false, jump: false, reload: false, switchTo: -1, useItem: false };
  rig: SoldierRig;
  kills = 0;
  deaths = 0;
  assists = 0;
  score = 0;
  headshots = 0;
  streak = 0;
  bestStreak = 0;
  multi = 0;
  lastKillT = -99;
  pelletsFired = 0;
  pelletsHit = 0;
  voxelsDestroyed = 0;
  /** enemies who hurt us recently (for assists), value = time of last hit */
  damagers = new Map<Soldier, number>();
  damageDealt = 0;
  coreDamage = 0;
  lastHurt = -99;
  lastAttacker: Soldier | null = null;
  lastHurtDir = new THREE.Vector3();
  spottedUntil = 0;
  markedUntil = 0;
  ads = false;
  sprinting = false;
  walkPhase = 0;
  deathT = 0;
  healLeft = 0;
  switchT = 0;
  itemLatch = false;
  c4: THREE.Object3D[] = [];
  visualY = 0;
  pendingLoadout: Loadout | null = null;
  lastShot = -99;
  footT = 0;
  rippleT = 0;
  readonly muzzle = new THREE.Vector3();
  readonly aimDir = new THREE.Vector3(0, 0, -1);

  constructor(
    public name: string,
    public team: Team,
    public isPlayer: boolean,
    loadout: Loadout,
  ) {
    this.rig = buildSoldier(team, isPlayer);
    this.applyLoadout(loadout);
  }

  applyLoadout(l: Loadout) {
    this.weapons = [new WeaponState(WEAPON[l.primary.id], l.primary.build), new WeaponState(WEAPON[l.secondary.id], l.secondary.build)];
    this.current = 0;
    this.item = l.item;
    this.itemCount = ITEMS.find((i) => i.id === l.item)!.count;
    setRigGun(this.rig, this.weapon.def, this.weapon.build);
    this.rig.laser.visible = this.weapon.stats.laser;
  }

  get weapon() {
    return this.weapons[this.current];
  }

  get eyeY() {
    return this.pos.y + 1.5;
  }

  get chestY() {
    return this.pos.y + 1.2;
  }

  switchWeapon(i: number) {
    if (i === this.current || i < 0 || i >= this.weapons.length) return;
    this.weapon.reloadT = 0;
    this.current = i;
    this.switchT = 0.35;
    this.weapon.spin = 0;
    setRigGun(this.rig, this.weapon.def, this.weapon.build);
    this.rig.laser.visible = this.weapon.stats.laser;
  }

  startReload() {
    const w = this.weapon;
    if (w.reloading || w.ammo >= w.stats.mag || w.reserve <= 0) return false;
    w.reloadT = w.stats.reload;
    return true;
  }

  speed(): number {
    const w = this.weapon.stats;
    let s = 4.7 * w.moveMul;
    if (this.ads) s *= w.adsMoveMul;
    if (this.sprinting) s *= 1.42;
    if (this.waterDepth > 0) s *= 1 - Math.min(this.waterDepth, 1.3) * 0.42;
    return s;
  }

  /** extra cone for bots (set from their skill), 1 for the player */
  spreadMul = 1;

  spread(): number {
    const w = this.weapon;
    const s = w.stats;
    let sp = this.ads ? s.adsSpread : s.hipSpread;
    const moving = Math.hypot(this.vel.x, this.vel.z) > 1;
    if (moving) sp *= this.ads ? 1.5 : 1.25;
    if (!this.onGround) sp *= 2;
    if (this.waterDepth > 1) sp *= 1.6;
    return sp + w.bloom;
  }

  update(game: Game, dt: number) {
    const t = game.time;
    if (!this.alive) {
      this.updateDead(game, dt);
      return;
    }
    const it = this.intent;
    const world = game.world;
    const w = this.weapon;

    // aim + facing
    const dx = it.aim.x - this.pos.x, dz = it.aim.z - this.pos.z;
    if (dx * dx + dz * dz > 0.01) this.yaw = Math.atan2(dx, dz);
    this.ads = it.ads && !this.sprinting;
    const wantSprint = it.sprint && !it.fire && Math.hypot(it.moveX, it.moveZ) > 0.3;
    this.sprinting = wantSprint && !this.ads;

    // movement
    const sp = this.speed();
    let mx = it.moveX, mz = it.moveZ;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const accel = this.onGround ? 16 : 4;
    this.vel.x = damp(this.vel.x, mx * sp, accel, dt);
    this.vel.z = damp(this.vel.z, mz * sp, accel, dt);
    if (it.jump && this.onGround && this.waterDepth < 0.9) {
      this.vel.y = 7.4;
      this.onGround = false;
      game.audio.foot(this.pos, 1.4);
    }
    this.vel.y -= GRAVITY * dt;
    if (this.waterDepth > 0.9) this.vel.y = Math.max(this.vel.y, -1.5);
    this.move(game, dt);

    this.waterDepth = Math.max(0, WATER_Y - this.pos.y);

    // footsteps / wading
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > 0.5 && this.onGround) {
      this.walkPhase += dt * hs * 2.4;
      this.footT -= dt * hs;
      if (this.footT <= 0) {
        this.footT = 1.7;
        if (this.waterDepth > 0.05) {
          game.renderer.water?.addRipple(this.pos.x, this.pos.z, 0.6);
          game.particles.splash(this.pos.x, WATER_Y, this.pos.z, 3, 0.4);
          game.audio.splash(this.pos, 0.3);
        } else game.audio.foot(this.pos, 1);
      }
    } else this.walkPhase *= Math.exp(-dt * 6);
    if (this.waterDepth > 0.05 && hs < 0.5) {
      this.rippleT -= dt;
      if (this.rippleT < 0) {
        this.rippleT = 1.1;
        game.renderer.water?.addRipple(this.pos.x, this.pos.z, 0.25);
      }
    }

    // healing
    if (this.healLeft > 0) {
      const h = Math.min(this.healLeft, 35 * dt);
      this.healLeft -= h;
      this.hp = Math.min(100, this.hp + h);
    }
    if (t - this.lastHurt > 6 && this.hp < 100) this.hp = Math.min(100, this.hp + 10 * dt);

    // weapon switching
    if (it.switchTo >= 0) {
      this.switchWeapon(it.switchTo);
      it.switchTo = -1;
    }
    if (this.switchT > 0) this.switchT -= dt;

    // reload
    if (it.reload) {
      if (this.startReload()) game.audio.reload(this.pos, this.isPlayer);
      it.reload = false;
    }
    if (w.reloadT > 0) {
      w.reloadT -= dt;
      if (w.reloadT <= 0) {
        const need = w.stats.mag - w.ammo;
        const take = Math.min(need, w.reserve);
        w.ammo += take;
        w.reserve -= take;
        w.reloadT = 0;
        if (this.isPlayer) game.audio.uiClick(0.6);
      }
    }
    w.cooldown -= dt;
    w.bloom *= Math.exp(-dt * 5.5);

    // muzzle & aim direction
    this.computeMuzzle();
    this.aimDir.copy(it.aim).sub(this.muzzle);
    const ad = this.aimDir.length();
    if (ad < 0.5) this.aimDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    else this.aimDir.divideScalar(ad);
    // keep shots mostly level unless deliberately aiming up/down
    this.aimDir.y = clamp(this.aimDir.y, -0.55, 0.55);
    this.aimDir.normalize();

    // firing
    const s = w.stats;
    if (s.spinUp > 0) {
      if (it.fire && !this.sprinting) w.spin = Math.min(1, w.spin + dt / s.spinUp);
      else w.spin = Math.max(0, w.spin - dt / (s.spinUp * 1.5));
    }
    const canFire = it.fire && !this.sprinting && !w.reloading && this.switchT <= 0 && (s.spinUp <= 0 || w.spin >= 1);
    if (!it.fire) w.triggerLatch = false;
    if (canFire && w.cooldown <= 0) {
      if (w.ammo <= 0) {
        if (this.startReload()) game.audio.reload(this.pos, this.isPlayer);
        else if (!w.triggerLatch) game.audio.dryFire(this.pos);
        w.triggerLatch = true;
      } else if (s.auto || !w.triggerLatch) {
        w.triggerLatch = true;
        w.ammo--;
        w.cooldown = Math.max(w.cooldown, 0) + 60 / s.rpm;
        this.lastShot = t;
        game.fireWeapon(this, w);
        w.bloom = Math.min(w.bloom + s.recoil, s.recoil * 12 + 0.05);
        if (w.ammo <= 0 && w.reserve > 0) {
          this.startReload();
          game.audio.reload(this.pos, this.isPlayer);
        }
      }
    }
    if (w.cooldown < 0) w.cooldown = 0;

    // items
    if (it.useItem && !this.itemLatch) {
      this.itemLatch = true;
      game.useItem(this);
    }
    if (!it.useItem) this.itemLatch = false;

    // supply zone refill
    const sup = game.info.supply[this.team];
    if (Math.hypot(this.pos.x - sup.x, this.pos.z - sup.z) < 5) {
      for (const ws of this.weapons) ws.reserve = Math.max(ws.reserve, ws.stats.mag * ws.stats.reserve);
      const max = ITEMS.find((i) => i.id === this.item)!.count;
      if (this.itemCount < max && Math.floor(t) % 4 === 0) this.itemCount = max;
    }

    this.animate(dt, t);
  }

  computeMuzzle() {
    const def = this.weapon.def;
    const f = gunMuzzleZ(def, this.weapon.build) + 0.33;
    const sy = Math.sin(this.bodyYaw), cy = Math.cos(this.bodyYaw);
    this.muzzle.set(this.pos.x + sy * f + cy * 0.06, this.pos.y + 1.25 + (def.model.tube ? 0.12 : 0), this.pos.z + cy * f - sy * 0.06);
  }

  private move(game: Game, dt: number) {
    const world = game.world;
    const r = SOLDIER_RADIUS, H = SOLDIER_HEIGHT;
    const p = this.pos;
    // unstick (rubble fell on us)
    if (world.boxSolid(p.x - r, p.y + 0.05, p.z - r, p.x + r, p.y + H, p.z + r)) {
      const top = world.boxTop(p.x - r, p.y, p.z - r, p.x + r, p.y + H, p.z + r);
      if (top > 0 && top - p.y < 1.6) p.y = top + 0.01;
    }
    const tryAxis = (ax: 'x' | 'z', d: number) => {
      if (d === 0) return;
      const nx = ax === 'x' ? p.x + d : p.x;
      const nz = ax === 'z' ? p.z + d : p.z;
      if (!world.boxSolid(nx - r, p.y + 0.02, nz - r, nx + r, p.y + H, nz + r)) {
        p.x = nx;
        p.z = nz;
        return;
      }
      // step up
      if (this.onGround || this.waterDepth > 0.3) {
        const top = world.boxTop(nx - r, p.y, nz - r, nx + r, p.y + STEP_HEIGHT + 0.02, nz + r);
        if (top > 0 && top - p.y <= STEP_HEIGHT + 0.01 && !world.boxSolid(nx - r, top + 0.02, nz - r, nx + r, top + H, nz + r)) {
          p.y = top;
          p.x = nx;
          p.z = nz;
          return;
        }
      }
      if (ax === 'x') this.vel.x = 0;
      else this.vel.z = 0;
    };
    // sub-step large moves
    const steps = Math.max(1, Math.ceil((Math.abs(this.vel.x) + Math.abs(this.vel.z)) * dt / 0.2));
    for (let i = 0; i < steps; i++) {
      tryAxis('x', (this.vel.x * dt) / steps);
      tryAxis('z', (this.vel.z * dt) / steps);
    }
    const ny = p.y + this.vel.y * dt;
    if (this.vel.y <= 0) {
      const top = world.boxTop(p.x - r * 0.9, ny, p.z - r * 0.9, p.x + r * 0.9, p.y + 0.02, p.z + r * 0.9);
      if (top >= 0 && top >= ny) {
        if (!this.onGround && this.vel.y < -9) game.audio.foot(this.pos, 1.6);
        p.y = top;
        this.vel.y = 0;
        this.onGround = true;
      } else {
        p.y = ny;
        this.onGround = false;
      }
    } else {
      if (world.boxSolid(p.x - r, p.y + H, p.z - r, p.x + r, ny + H, p.z + r)) this.vel.y = 0;
      else p.y = ny;
      this.onGround = false;
    }
    if (p.y < -5) p.y = world.floorAt(p.x, p.z);
    // map bounds
    p.x = clamp(p.x, 1, game.mapW - 1);
    p.z = clamp(p.z, 1, game.mapD - 1);
  }

  private animate(dt: number, t: number) {
    const rig = this.rig;
    this.bodyYaw += angleDiff(this.bodyYaw, this.yaw) * Math.min(1, dt * 18);
    rig.body.rotation.y = this.bodyYaw;
    this.visualY = damp(this.visualY, this.pos.y, 22, dt);
    if (Math.abs(this.visualY - this.pos.y) > 1) this.visualY = this.pos.y;
    rig.root.position.set(this.pos.x, this.visualY, this.pos.z);
    // legs swing relative to motion
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const amp = Math.min(1, hs / 4) * 0.75;
    const sw = Math.sin(this.walkPhase) * amp;
    // motion direction relative to body facing: swing along it
    const mvYaw = Math.atan2(this.vel.x, this.vel.z);
    const rel = angleDiff(this.bodyYaw, mvYaw);
    const fwd = Math.cos(rel), side = Math.sin(rel);
    rig.legL.rotation.set(sw * fwd, 0, -sw * side * 0.6);
    rig.legR.rotation.set(-sw * fwd, 0, sw * side * 0.6);
    const bob = Math.abs(Math.cos(this.walkPhase)) * amp * 0.05;
    rig.upper.position.y = bob;
    rig.gunMount.position.y = 1.2 + bob;
    // recoil kick + sprint pose
    const kick = Math.max(0, 1 - (t - this.lastShot) * 10) * Math.min(0.12, this.weapon.stats.recoil * 2.5);
    rig.gunMount.position.z = 0.33 - kick;
    rig.gunMount.rotation.x = this.sprinting ? 0.5 : -kick * 2 - (this.weapon.reloading ? 0.6 : 0);
    rig.body.rotation.x = 0;
    rig.root.visible = true;
    rig.ring.visible = true;
  }

  private updateDead(game: Game, dt: number) {
    this.deathT += dt;
    const rig = this.rig;
    if (this.deathT < 0.5) {
      rig.body.rotation.x = -Math.min(1.45, this.deathT * 4);
      rig.root.position.y = this.pos.y - Math.min(0.2, this.deathT * 0.4);
    } else if (rig.root.visible) {
      rig.root.visible = false;
      game.popSoldier(this);
    }
  }

  hurt(amount: number, from: Soldier | null, dir: THREE.Vector3, time: number) {
    if (!this.alive || time < this.protectedUntil) return false;
    this.hp -= amount;
    this.lastHurt = time;
    this.lastAttacker = from;
    this.lastHurtDir.copy(dir);
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.deathT = 0;
      this.deaths++;
      this.vel.set(0, 0, 0);
      return true;
    }
    return false;
  }

  respawn(x: number, y: number, z: number, time: number) {
    if (this.pendingLoadout) {
      this.applyLoadout(this.pendingLoadout);
      this.pendingLoadout = null;
    }
    this.pos.set(x, y, z);
    this.visualY = y;
    this.vel.set(0, 0, 0);
    this.hp = 100;
    this.alive = true;
    this.protectedUntil = time + 2.5;
    this.healLeft = 0;
    for (const w of this.weapons) w.refill();
    this.itemCount = ITEMS.find((i) => i.id === this.item)!.count;
    this.switchWeapon(0);
    this.rig.body.rotation.x = 0;
    this.rig.root.visible = true;
  }
}
