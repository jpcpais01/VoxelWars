import * as THREE from 'three';
import { CHEST_HEIGHT, EYE_HEIGHT, WATER_Y } from '../core/config';
import { angleDiff, clamp } from '../core/noise';
import type { Game } from './Game';
import { NavPoint } from './nav';
import { Soldier } from './Soldier';

export type Role = 'attack' | 'defend' | 'flank';
type State = 'advance' | 'engage' | 'cover' | 'retreat' | 'defend' | 'investigate' | 'siege' | 'regroup';

interface Known {
  s: Soldier;
  x: number;
  z: number;
  t: number;
  visible: boolean;
}

const v3 = new THREE.Vector3();

export class Bot {
  role: Role = 'attack';
  lane = 0;
  laneIdx = 0;
  state: State = 'advance';
  path: NavPoint[] | null = null;
  pathIdx = 0;
  goalX = 0;
  goalZ = 0;
  repathAt = 0;
  thinkAt = 0;
  known = new Map<number, Known>();
  target: Known | null = null;
  trackT = 0;
  reactAt = 0;
  aimErr = new THREE.Vector3();
  burstLeft = 0;
  pauseUntil = 0;
  strafe = 1;
  strafeUntil = 0;
  cover: { x: number; z: number } | null = null;
  coverUntil = 0;
  peekUntil = 0;
  lastProgressPos = new THREE.Vector2();
  lastProgressT = 0;
  stuckCount = 0;
  defendSpot = 0;
  itemCd = 0;
  heard: { x: number; z: number; t: number } | null = null;
  regroupUntil = 0;
  lookYaw = 0;
  lookAt = new THREE.Vector3();
  c4Placed = false;
  skill: number;
  private desiredYaw = 0;

  constructor(public s: Soldier, public game: Game, seed: number) {
    this.skill = 0.62 + (seed % 7) * 0.05;
    this.thinkAt = Math.random() * 0.3;
    this.strafe = Math.random() < 0.5 ? 1 : -1;
  }

  get enemyTeam() {
    return (1 - this.s.team) as 0 | 1;
  }

  onRespawn() {
    this.laneIdx = 0;
    this.path = null;
    this.state = this.role === 'defend' ? 'defend' : 'advance';
    this.target = null;
    this.known.clear();
    this.cover = null;
    this.c4Placed = false;
    this.regroupUntil = 0;
  }

  // ------------------------------------------------------------------------------------ perception
  private perceive() {
    const g = this.game;
    const s = this.s;
    const ex = s.pos.x, ez = s.pos.z;
    const eyeY = s.pos.y + EYE_HEIGHT;
    const fx = Math.sin(s.bodyYaw), fz = Math.cos(s.bodyYaw);
    for (const e of g.soldiers) {
      if (e.team === s.team || !e.alive) continue;
      const dx = e.pos.x - ex, dz = e.pos.z - ez;
      const d = Math.hypot(dx, dz);
      if (d > 52) continue;
      const cosA = (dx * fx + dz * fz) / (d + 1e-4);
      const recentlyShot = g.time - e.lastShot < 0.6 && !e.weapon.stats.suppressed;
      const inFov = cosA > 0.2 || d < 7 || (recentlyShot && d < 30);
      if (!inFov) continue;
      let vis = g.world.lineOfSight(ex, eyeY, ez, e.pos.x, e.pos.y + CHEST_HEIGHT, e.pos.z);
      if (!vis) vis = g.world.lineOfSight(ex, eyeY, ez, e.pos.x, e.pos.y + EYE_HEIGHT + 0.1, e.pos.z);
      if (vis && g.smokeBlocks(ex, eyeY, ez, e.pos.x, e.pos.y + 1.2, e.pos.z)) vis = false;
      const k = this.known.get(e.id);
      if (vis) {
        if (!k) this.reactAt = g.time + (0.35 + (1 - this.skill) * 0.5) * (d > 25 ? 1.2 : 1);
        this.known.set(e.id, { s: e, x: e.pos.x, z: e.pos.z, t: g.time, visible: true });
        g.reportSighting(s.team, e);
      } else if (k) k.visible = false;
    }
    // team intel
    for (const intel of g.intel[s.team].values()) {
      if (g.time - intel.t > 4 || !intel.s.alive) continue;
      const k = this.known.get(intel.s.id);
      if (!k || k.t < intel.t) this.known.set(intel.s.id, { s: intel.s, x: intel.x, z: intel.z, t: intel.t, visible: k?.visible ?? false });
    }
    // forget old
    for (const [id, k] of this.known) if (!k.s.alive || g.time - k.t > 9) this.known.delete(id);
    // hearing
    for (const n of g.noises) {
      if (n.team === s.team || g.time - n.t > 0.5) continue;
      const d = Math.hypot(n.x - ex, n.z - ez);
      if (d < n.radius) this.heard = { x: n.x, z: n.z, t: n.t };
    }
    // choose target
    let best: Known | null = null;
    let bestScore = -1e9;
    for (const k of this.known.values()) {
      const d = Math.hypot(k.x - ex, k.z - ez);
      let sc = -d;
      if (k.visible) sc += 40;
      if (g.time - k.t > 2) sc -= 25;
      if (k.s.lastAttacker === s) sc += 5;
      if (s.lastAttacker === k.s && g.time - s.lastHurt < 3) sc += 18;
      sc += (100 - k.s.hp) * 0.08;
      // defenders prioritise intruders near the core
      if (this.role === 'defend') {
        const core = g.info.cores[s.team];
        sc -= Math.hypot(k.x - core.x, k.z - core.z) * 0.4;
      }
      if (sc > bestScore) {
        bestScore = sc;
        best = k;
      }
    }
    if (best && (!this.target || this.target.s !== best.s)) this.trackT = 0;
    this.target = best;
  }

  // ------------------------------------------------------------------------------------ navigation
  private goTo(x: number, z: number, force = false) {
    const g = this.game;
    const moved = Math.hypot(x - this.goalX, z - this.goalZ) > 2.5;
    if (!force && !moved && this.path && g.time < this.repathAt) return;
    if (g.navBudget <= 0 && this.path && !force) return;
    g.navBudget--;
    this.goalX = x;
    this.goalZ = z;
    this.path = g.nav.findPath(this.s.pos.x, this.s.pos.z, x, z);
    this.pathIdx = 0;
    this.repathAt = g.time + 3 + Math.random() * 2;
  }

  /** returns desired move direction (unit-ish) */
  private follow(out: { x: number; z: number; jump: boolean }, slowRadius = 0.8): boolean {
    out.x = 0;
    out.z = 0;
    out.jump = false;
    if (!this.path || this.path.length === 0) return false;
    const p = this.s.pos;
    while (this.pathIdx < this.path.length) {
      const n = this.path[this.pathIdx];
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      const last = this.pathIdx === this.path.length - 1;
      if (d < (last ? slowRadius : 0.7)) {
        this.pathIdx++;
        continue;
      }
      out.x = (n.x - p.x) / d;
      out.z = (n.z - p.z) / d;
      if (n.jump && d < 1.8) out.jump = true;
      return true;
    }
    return false;
  }

  private checkStuck(moving: boolean) {
    const g = this.game;
    const p = this.s.pos;
    if (!moving) {
      this.lastProgressT = g.time;
      this.lastProgressPos.set(p.x, p.z);
      return;
    }
    if (g.time - this.lastProgressT > 1.3) {
      const moved = Math.hypot(p.x - this.lastProgressPos.x, p.z - this.lastProgressPos.y);
      if (moved < 0.5) {
        this.stuckCount++;
        this.s.intent.jump = true;
        if (this.stuckCount % 2 === 0) {
          this.path = null;
          this.repathAt = 0;
        }
        if (this.stuckCount >= 3) {
          // blast through whatever is in the way
          const fx = Math.sin(this.s.bodyYaw), fz = Math.cos(this.s.bodyYaw);
          this.s.intent.aim.set(p.x + fx * 2, p.y + 0.9, p.z + fz * 2);
          this.s.intent.fire = true;
        }
      } else this.stuckCount = 0;
      this.lastProgressT = g.time;
      this.lastProgressPos.set(p.x, p.z);
    }
  }

  // ------------------------------------------------------------------------------------ helpers
  private findCover(fromX: number, fromZ: number, fromY: number): { x: number; z: number } | null {
    const g = this.game;
    const p = this.s.pos;
    let best: { x: number; z: number } | null = null;
    let bestScore = -1e9;
    const toEnemy = Math.atan2(fromX - p.x, fromZ - p.z);
    for (let i = 0; i < 14; i++) {
      const a = toEnemy + Math.PI + (i / 14 - 0.5) * Math.PI * 1.6;
      const r = 2.5 + (i % 3) * 2.5;
      const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
      const k = g.nav.cellOf(x, z);
      if (!g.nav.walkable(k)) continue;
      const fy = g.nav.floorM(k);
      if (fy < WATER_Y - 0.5) continue;
      // cover if the enemy cannot see our chest there
      if (g.world.lineOfSight(fromX, fromY, fromZ, x, fy + CHEST_HEIGHT, z)) continue;
      let sc = -r * 0.6;
      // prefer spots we can peek from (head height visible)
      if (g.world.lineOfSight(fromX, fromY, fromZ, x, fy + 1.75, z)) sc += 2;
      for (const a2 of g.soldiers) if (a2 !== this.s && a2.team === this.s.team && a2.alive && Math.hypot(a2.pos.x - x, a2.pos.z - z) < 2.5) sc -= 4;
      if (sc > bestScore) {
        bestScore = sc;
        best = { x, z };
      }
    }
    return best;
  }

  private allyInLine(tx: number, tz: number) {
    const p = this.s.pos;
    const dx = tx - p.x, dz = tz - p.z;
    const L = Math.hypot(dx, dz);
    for (const a of this.game.soldiers) {
      if (a === this.s || a.team !== this.s.team || !a.alive) continue;
      const ax = a.pos.x - p.x, az = a.pos.z - p.z;
      const t = (ax * dx + az * dz) / (L * L);
      if (t < 0 || t > 1) continue;
      const cx = p.x + dx * t - a.pos.x, cz = p.z + dz * t - a.pos.z;
      if (cx * cx + cz * cz < 0.8) return true;
    }
    return false;
  }

  private laneTarget() {
    const lane = this.game.info.lanes[this.s.team][this.lane];
    this.laneIdx = clamp(this.laneIdx, 0, lane.length - 1);
    // advance index when close or when a later point is closer
    const p = this.s.pos;
    for (let i = lane.length - 1; i > this.laneIdx; i--) {
      if (Math.hypot(lane[i].x - p.x, lane[i].z - p.z) < Math.hypot(lane[this.laneIdx].x - p.x, lane[this.laneIdx].z - p.z) - 6) {
        this.laneIdx = i;
        break;
      }
    }
    const pt = lane[this.laneIdx];
    if (Math.hypot(pt.x - p.x, pt.z - p.z) < 4 && this.laneIdx < lane.length - 1) this.laneIdx++;
    return lane[this.laneIdx];
  }

  private chooseWeaponFor(dist: number, vsCore: boolean, hiddenTarget: boolean) {
    const s = this.s;
    const ws = s.weapons;
    const explosive = (i: number) => ws[i].stats.projectile !== 'bullet';
    let pick = 0;
    const usable = (i: number) => ws[i].ammo > 0 || ws[i].reserve > 0;
    if (vsCore || hiddenTarget) {
      for (let i = 0; i < ws.length; i++) if (explosive(i) && usable(i)) pick = i;
    } else {
      // closest-range weapon among usable non-explosives, unless only explosives remain
      pick = usable(0) ? 0 : 1;
      if (explosive(pick) && dist < 6 && usable(1 - pick) && !explosive(1 - pick)) pick = 1 - pick;
      if (ws[pick].ammo === 0 && ws[pick].reloading && dist < 12 && ws[1 - pick].ammo > 0 && !explosive(1 - pick)) pick = 1 - pick;
      if (explosive(pick) && dist > 8 && dist < 40 && Math.random() < 0.02 && ws[pick].ammo > 0) pick = pick; // keep
    }
    if (pick !== s.current) s.intent.switchTo = pick;
  }

  private aimAt(x: number, y: number, z: number, dt: number, err = 1) {
    const s = this.s;
    this.trackT += dt;
    // aim error shrinks while tracking
    const e = (1.6 - this.skill) * Math.exp(-this.trackT * 1.6 * this.skill) * err + 0.08 * (1 - this.skill);
    if (Math.random() < dt * 4) this.aimErr.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 2).multiplyScalar(e);
    this.lookAt.set(x + this.aimErr.x, y + this.aimErr.y, z + this.aimErr.z);
    this.desiredYaw = Math.atan2(this.lookAt.x - s.pos.x, this.lookAt.z - s.pos.z);
  }

  // ------------------------------------------------------------------------------------ main
  update(dt: number) {
    const s = this.s;
    const g = this.game;
    const it = s.intent;
    if (!s.alive) {
      it.fire = false;
      return;
    }
    it.fire = false;
    it.jump = false;
    it.useItem = false;
    it.sprint = false;
    it.ads = false;
    this.itemCd -= dt;

    if (g.time >= this.thinkAt) {
      this.thinkAt = g.time + 0.16 + Math.random() * 0.1;
      this.perceive();
    }

    const p = s.pos;
    const mv = { x: 0, z: 0, jump: false };
    let moving = false;
    const enemyCore = g.cores[this.enemyTeam];
    const ownCore = g.cores[s.team];
    const tgt = this.target;
    const tgtVisible = !!tgt && tgt.visible && g.time - tgt.t < 0.4;
    const w = s.weapon;

    // ---- medkit when safe & hurt
    if (s.item === 'medkit' && s.itemCount > 0 && s.hp < 55 && !tgtVisible && this.itemCd <= 0) {
      it.useItem = true;
      this.itemCd = 4;
    }

    // ---- state selection
    if (s.hp < 32 && tgtVisible && this.state !== 'retreat') {
      this.state = 'retreat';
      this.cover = null;
    } else if (tgtVisible && this.state !== 'retreat') {
      if (this.state !== 'engage' && this.state !== 'cover') this.state = 'engage';
    } else if (this.state === 'retreat' && (s.hp > 70 || !tgt)) {
      this.state = this.role === 'defend' ? 'defend' : 'advance';
    } else if (!tgtVisible && (this.state === 'engage' || this.state === 'cover')) {
      this.state = tgt && g.time - tgt.t < 6 ? 'investigate' : this.role === 'defend' ? 'defend' : 'advance';
    } else if (this.state === 'investigate' && (!tgt || g.time - tgt.t > 6)) {
      if (this.heard && g.time - this.heard.t < 4) {
        /* keep investigating the noise */
      } else this.state = this.role === 'defend' ? 'defend' : 'advance';
    }
    if ((this.state === 'advance' || this.state === 'siege' || this.state === 'regroup') && this.role === 'defend') this.state = 'defend';
    if (this.state === 'defend' && this.role !== 'defend') this.state = 'advance';

    // ---- behaviours
    switch (this.state) {
      case 'advance':
      case 'regroup': {
        const dCore = Math.hypot(enemyCore.pos.x - p.x, enemyCore.pos.z - p.z);
        if (dCore < 26) {
          this.state = 'siege';
          break;
        }
        const lt = this.laneTarget();
        // wait for a buddy at the river before pushing across
        const lane = g.info.lanes[s.team][this.lane];
        const mid = Math.floor(lane.length / 2);
        if (this.laneIdx === mid - 1 && this.regroupUntil === 0) this.regroupUntil = g.time + 6;
        if (this.regroupUntil > g.time) {
          const buddies = g.soldiers.filter((a) => a !== s && a.team === s.team && a.alive && Math.hypot(a.pos.x - p.x, a.pos.z - p.z) < 14).length;
          if (buddies >= 1) this.regroupUntil = g.time - 1;
          else if (Math.hypot(lt.x - p.x, lt.z - p.z) < 6) {
            this.state = 'regroup';
            this.lookTowards(lt.x + (lane[Math.min(lane.length - 1, this.laneIdx + 1)].x - lt.x), lt.z + 8 * (s.team === 0 ? -1 : 1));
            break;
          }
        }
        this.state = 'advance';
        this.goTo(lt.x, lt.z);
        moving = this.follow(mv, 2);
        if (!moving) this.path = null;
        it.sprint = !tgt && s.hp > 60;
        if (this.heard && g.time - this.heard.t < 1.5) this.lookTowards(this.heard.x, this.heard.z);
        else this.lookAlongPath(mv);
        break;
      }
      case 'siege': {
        // attack the enemy core
        const cx = enemyCore.pos.x, cz = enemyCore.pos.z, cy = enemyCore.pos.y + 1.4;
        const eyeY = p.y + EYE_HEIGHT;
        const los = g.world.lineOfSight(p.x, eyeY, p.z, cx, cy, cz);
        const dCore = Math.hypot(cx - p.x, cz - p.z);
        if (!enemyCore.alive) break;
        if (los && dCore < 30) {
          this.chooseWeaponFor(dCore, true, false);
          this.aimAt(cx, cy, cz, dt, 0.4);
          if (this.yawReady(0.15)) it.fire = this.burst(dt, true);
          // strafe a little while shooting
          this.strafeMove(mv, cx, cz, 0.6);
          moving = true;
          // plant a demo charge if we are right next to it
          if (s.item === 'c4' && s.itemCount > 0 && dCore < 5 && !this.c4Placed && this.itemCd <= 0) {
            it.useItem = true;
            this.c4Placed = true;
            this.itemCd = 1.5;
          }
          if (s.item === 'frag' && s.itemCount > 0 && dCore < 18 && this.itemCd <= 0) {
            it.useItem = true;
            this.itemCd = 6;
          }
        } else {
          // move to a door approach point
          const ap = g.coreApproach(this.enemyTeam, s.id);
          this.goTo(ap.x, ap.z);
          moving = this.follow(mv, 1.2);
          if (!moving) {
            // blast our way in
            this.chooseWeaponFor(dCore, true, true);
            this.aimAt(cx, cy, cz, dt, 0.3);
            if (this.yawReady(0.2)) it.fire = this.burst(dt, true);
          } else this.lookAlongPath(mv);
        }
        if (this.c4Placed && s.c4.length > 0 && dCore > 7) {
          it.useItem = true; // detonate
          this.c4Placed = false;
        }
        break;
      }
      case 'defend': {
        const spots = g.info.defendSpots[s.team];
        const spot = spots[this.defendSpot % spots.length];
        // respond to attacks on the core
        if (g.time - ownCore.lastHit < 4 && ownCore.lastHitFrom) {
          const a = ownCore.lastHitFrom;
          this.goTo(a.x, a.z);
        } else this.goTo(spot.x, spot.z);
        moving = this.follow(mv, 1.2);
        if (moving) this.lookAlongPath(mv);
        else {
          // scan the approaches
          const away = s.team === 0 ? -1 : 1;
          const t = g.time * 0.35 + this.s.id;
          this.lookTowards(spot.x + Math.sin(t) * 14, spot.z + away * 18);
          if (Math.random() < dt * 0.15) this.defendSpot = (this.defendSpot + 1 + ((Math.random() * 3) | 0)) % spots.length;
        }
        if (this.heard && g.time - this.heard.t < 2) this.lookTowards(this.heard.x, this.heard.z);
        break;
      }
      case 'investigate': {
        const tx = tgt ? tgt.x : this.heard ? this.heard.x : p.x;
        const tz = tgt ? tgt.z : this.heard ? this.heard.z : p.z;
        this.goTo(tx, tz);
        moving = this.follow(mv, 2);
        this.lookTowards(tx, tz);
        it.ads = true;
        // pre-fire suppression on recently seen positions
        if (tgt && g.time - tgt.t < 1.5 && w.stats.projectile === 'bullet' && Math.hypot(tx - p.x, tz - p.z) < 25) {
          this.aimAt(tx, (tgt.s.pos.y || p.y) + 1.2, tz, dt, 1.5);
          if (this.yawReady(0.2) && Math.random() < 0.5) it.fire = this.burst(dt, false);
        }
        // flush them out with a grenade
        if (tgt && g.time - tgt.t > 1 && g.time - tgt.t < 4 && (s.item === 'frag') && s.itemCount > 0 && this.itemCd <= 0) {
          const d = Math.hypot(tx - p.x, tz - p.z);
          if (d > 7 && d < 22) {
            it.aim.set(tx, p.y, tz);
            this.lookAt.set(tx, p.y, tz);
            it.useItem = true;
            this.itemCd = 8;
          }
        }
        if (!moving && (!tgt || Math.hypot(tx - p.x, tz - p.z) < 3)) {
          this.state = this.role === 'defend' ? 'defend' : 'advance';
          this.heard = null;
        }
        break;
      }
      case 'engage':
      case 'cover': {
        if (!tgt) break;
        const e = tgt.s;
        const ex = e.pos.x, ez = e.pos.z, ey = e.pos.y + CHEST_HEIGHT;
        const d = Math.hypot(ex - p.x, ez - p.z);
        this.chooseWeaponFor(d, false, false);
        const st = s.weapon.stats;
        // lead slow projectiles
        let lx = ex, lz = ez;
        if (st.velocity < 120) {
          const tt = d / st.velocity;
          lx += e.vel.x * tt;
          lz += e.vel.z * tt;
        }
        this.aimAt(lx, ey, lz, dt, 1);
        it.ads = d > 14 && st.adsZoom > 4;
        const pref = clamp(st.range * 0.55, 6, 30);
        const hurtRecently = g.time - s.lastHurt < 1.2;
        const needReload = s.weapon.ammo === 0 || s.weapon.reloading;

        if (this.state === 'engage' && (hurtRecently || needReload) && g.time > this.coverUntil) {
          const c = this.findCover(ex, ey + 0.3, ez);
          if (c) {
            this.cover = c;
            this.state = 'cover';
            this.coverUntil = g.time + 2 + Math.random() * 2;
            this.goTo(c.x, c.z, true);
          } else this.coverUntil = g.time + 1.5;
        }

        if (this.state === 'cover' && this.cover) {
          const atCover = Math.hypot(this.cover.x - p.x, this.cover.z - p.z) < 0.8;
          if (!atCover) {
            moving = this.follow(mv, 0.5);
            it.sprint = !moving ? false : d > 6;
            if (!moving) this.cover = null;
          } else {
            if (s.weapon.ammo < s.weapon.stats.mag * 0.5 && !s.weapon.reloading) it.reload = true;
            if (g.time > this.coverUntil && !s.weapon.reloading) {
              // peek: step sideways out of cover
              if (this.peekUntil < g.time) this.peekUntil = g.time + 1.2 + Math.random();
              this.strafeMove(mv, ex, ez, 1);
              moving = true;
              if (g.time > this.peekUntil - 0.2) {
                this.coverUntil = g.time + 1.5 + Math.random() * 2;
              }
            }
          }
          if (tgtVisible && g.time >= this.reactAt && this.yawReady(0.12) && !this.allyInLine(ex, ez)) it.fire = this.burst(dt, false);
          if (g.time > this.coverUntil + 4) {
            this.state = 'engage';
            this.cover = null;
          }
        } else {
          // open engagement: strafe + manage distance
          const dirx = (ex - p.x) / (d + 1e-4), dirz = (ez - p.z) / (d + 1e-4);
          let fwd = 0;
          if (d > pref * 1.3) fwd = 1;
          else if (d < pref * 0.6 && st.pellets === 1) fwd = -0.7;
          if (st.pellets > 1 && d > 5) fwd = 1;
          if (g.time > this.strafeUntil) {
            this.strafe = -this.strafe;
            this.strafeUntil = g.time + 0.6 + Math.random() * 1.4;
          }
          mv.x = dirx * fwd + -dirz * this.strafe * 0.8;
          mv.z = dirz * fwd + dirx * this.strafe * 0.8;
          // do not walk off into deep water mid-fight
          const nk = g.nav.cellOf(p.x + mv.x * 1.5, p.z + mv.z * 1.5);
          if (!g.nav.walkable(nk) || g.nav.cost[nk] > 3) {
            this.strafe = -this.strafe;
            mv.x = dirx * fwd + -dirz * this.strafe * 0.8;
            mv.z = dirz * fwd + dirx * this.strafe * 0.8;
          }
          moving = Math.hypot(mv.x, mv.z) > 0.1;
          if (g.time >= this.reactAt && this.yawReady(0.12) && !this.allyInLine(ex, ez)) it.fire = this.burst(dt, false);
          // explosive opportunities
          if (s.item === 'frag' && s.itemCount > 0 && this.itemCd <= 0 && d > 8 && d < 20 && Math.random() < dt * 0.4) {
            it.aim.set(ex, e.pos.y, ez);
            it.useItem = true;
            this.itemCd = 7;
          }
          if (s.item === 'smoke' && s.itemCount > 0 && this.itemCd <= 0 && s.hp < 60 && d < 30) {
            it.aim.set(p.x + dirx * 4, p.y, p.z + dirz * 4);
            it.useItem = true;
            this.itemCd = 14;
          }
        }
        if (!tgtVisible && g.time - tgt.t > 1) this.state = 'investigate';
        break;
      }
      case 'retreat': {
        const home = g.info.spawns[s.team][0];
        const threat = tgt ? tgt : null;
        if (threat && !this.cover) this.cover = this.findCover(threat.x, threat.s.pos.y + 1.4, threat.z);
        const dest = this.cover ?? home;
        this.goTo(dest.x, dest.z);
        moving = this.follow(mv, 0.6);
        it.sprint = true;
        if (threat && threat.visible) {
          this.aimAt(threat.x, threat.s.pos.y + 1.2, threat.z, dt, 1.4);
          if (!moving && this.yawReady(0.2)) it.fire = this.burst(dt, false);
          it.sprint = moving;
        } else this.lookAlongPath(mv);
        if (s.item === 'smoke' && s.itemCount > 0 && this.itemCd <= 0) {
          it.aim.set(p.x, p.y, p.z);
          it.useItem = true;
          this.itemCd = 14;
        }
        break;
      }
    }

    // ---- reload when idle
    if (!tgtVisible && s.weapon.ammo < s.weapon.stats.mag * 0.4 && !s.weapon.reloading && s.weapon.reserve > 0) it.reload = true;
    if (!tgtVisible && this.state !== 'siege' && s.current !== 0 && (s.weapons[0].ammo > 0 || s.weapons[0].reserve > 0)) it.switchTo = 0;

    // ---- turn toward look target at a human-ish rate
    const curYaw = Math.atan2(it.aim.x - p.x, it.aim.z - p.z);
    const dy = angleDiff(curYaw, this.desiredYaw);
    const maxTurn = (5 + this.skill * 5) * dt;
    const ny = curYaw + clamp(dy, -maxTurn, maxTurn);
    if (!it.useItem || this.lookAt.lengthSq() === 0) {
      const dist = Math.max(2, Math.hypot(this.lookAt.x - p.x, this.lookAt.z - p.z));
      it.aim.set(p.x + Math.sin(ny) * dist, this.lookAt.y || p.y + 1.2, p.z + Math.cos(ny) * dist);
    }

    if (mv.jump) it.jump = true;
    it.moveX = mv.x;
    it.moveZ = mv.z;
    this.checkStuck(moving);
  }

  private yawReady(tol: number) {
    const p = this.s.pos;
    const cur = Math.atan2(this.s.intent.aim.x - p.x, this.s.intent.aim.z - p.z);
    return Math.abs(angleDiff(cur, this.desiredYaw)) < tol + 0.05;
  }

  private burst(dt: number, sustained: boolean) {
    const g = this.game;
    const st = this.s.weapon.stats;
    if (g.time < this.pauseUntil) return false;
    if (!st.auto) {
      // tap fire semi-autos with human cadence
      if (Math.random() < dt * (3 + this.skill * 3)) {
        this.pauseUntil = g.time + 60 / st.rpm + 0.05;
        return true;
      }
      return false;
    }
    if (this.burstLeft <= 0) {
      this.burstLeft = sustained ? 0.8 + Math.random() : 0.25 + Math.random() * 0.45 * this.skill;
      if (st.spinUp > 0) this.burstLeft += 1.2;
    }
    this.burstLeft -= dt;
    if (this.burstLeft <= 0) this.pauseUntil = g.time + 0.15 + Math.random() * 0.35;
    return true;
  }

  private strafeMove(mv: { x: number; z: number }, tx: number, tz: number, amt: number) {
    const p = this.s.pos;
    const d = Math.hypot(tx - p.x, tz - p.z) + 1e-4;
    const dx = (tx - p.x) / d, dz = (tz - p.z) / d;
    if (this.game.time > this.strafeUntil) {
      this.strafe = -this.strafe;
      this.strafeUntil = this.game.time + 0.7 + Math.random() * 1.2;
    }
    mv.x = -dz * this.strafe * amt;
    mv.z = dx * this.strafe * amt;
    const nk = this.game.nav.cellOf(p.x + mv.x, p.z + mv.z);
    if (!this.game.nav.walkable(nk)) {
      mv.x = -mv.x;
      mv.z = -mv.z;
    }
  }

  private lookTowards(x: number, z: number) {
    this.lookAt.set(x, this.s.pos.y + 1.2, z);
    this.desiredYaw = Math.atan2(x - this.s.pos.x, z - this.s.pos.z);
    this.trackT = 0;
  }

  private lookAlongPath(mv: { x: number; z: number }) {
    if (Math.hypot(mv.x, mv.z) < 0.1) return;
    const p = this.s.pos;
    this.lookTowards(p.x + mv.x * 8, p.z + mv.z * 8);
    void v3;
  }
}
