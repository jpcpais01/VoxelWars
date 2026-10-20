import * as THREE from 'three';
import { CHEST_HEIGHT, MAP_D, MAP_W, MATCH_TIME, RESPAWN_TIME, TEAM_BLUE, TEAM_RED, Team, VOXEL, WATER_Y } from '../core/config';
import { mulberry32 } from '../core/noise';
import { Audio } from '../audio/Audio';
import { Debris, Particles } from '../render/effects';
import { Renderer } from '../render/Renderer';
import { ViewLight, Viewmodel } from '../render/Viewmodel';
import { shared } from '../render/shaderlib';
import { ChunkManager } from '../world/ChunkManager';
import { Destruction } from '../world/destruction';
import { MapInfo } from '../world/generator';
import { MATS } from '../world/materials';
import { World, newHit } from '../world/World';
import { Bot, Role } from './Bot';
import { Core } from './Core';
import { Input } from './Input';
import { boxes, toyMaterial } from './models';
import { Nav } from './nav';
import { PlayerController } from './Player';
import { Soldier, WeaponState } from './Soldier';
import { Loadout, Stats, WEAPON, randomLoadout } from './weapons';

type ProjKind = 'bullet' | 'rocket' | 'grenade' | 'frag' | 'smoke' | 'c4';

interface Proj {
  kind: ProjKind;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  owner: Soldier;
  team: Team;
  stats: Stats | null;
  dmg: number;
  traveled: number;
  life: number;
  fuse: number;
  mesh: THREE.Object3D | null;
  stuck: boolean;
  dead: boolean;
  wet: boolean;
  trailT: number;
  weaponName: string;
}

interface Smoke {
  x: number;
  y: number;
  z: number;
  t: number;
  life: number;
  emit: number;
}

export interface FeedEntry {
  t: number;
  killer: string;
  killerTeam: Team;
  victim: string;
  victimTeam: Team;
  weapon: string;
  special?: string;
}

export interface GameEvents {
  onKill(e: FeedEntry): void;
  onHitMarker(kill: boolean, head: boolean): void;
  onPlayerHurt(dir: THREE.Vector3, amount: number): void;
  onMessage(text: string, kind: 'info' | 'warn' | 'good'): void;
  onEnd(winner: Team): void;
  /** points the player just earned */
  onScore(label: string, points: number, big?: boolean): void;
  /** damage the player dealt, at a world position */
  onDamage(x: number, y: number, z: number, amount: number, head: boolean, killed: boolean): void;
}

export type Difficulty = 'recruit' | 'regular' | 'veteran';
export interface MatchOptions {
  difficulty: Difficulty;
  minutes: number;
}
/** bot skill shift per difficulty (base skills sit around 0.42..0.69) */
const DIFF_SKILL: Record<Difficulty, number> = { recruit: -0.22, regular: 0, veteran: 0.18 };

const BOT_NAMES = ['Viper', 'Maple', 'Kodiak', 'Juno', 'Rook', 'Sable', 'Fennec', 'Nova', 'Bishop', 'Wren', 'Atlas', 'Moss', 'Echo', 'Pike', 'Tundra', 'Quill', 'Hawk', 'Birch'];

const tmpV = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpR = new THREE.Vector3();
const tmpU = new THREE.Vector3();
const hit = newHit();
const tmpQ = new THREE.Quaternion();

export class Game {
  time = 0;
  readonly mapW = MAP_W;
  readonly mapD = MAP_D;
  soldiers: Soldier[] = [];
  bots: Bot[] = [];
  cores: Core[] = [];
  player!: Soldier;
  pc!: PlayerController;
  projectiles: Proj[] = [];
  smokes: Smoke[] = [];
  noises: { x: number; z: number; t: number; team: Team; radius: number }[] = [];
  intel: Map<number, { s: Soldier; x: number; z: number; t: number }>[] = [new Map(), new Map()];
  readonly particles: Particles;
  readonly debris: Debris;
  readonly viewmodel = new Viewmodel();
  readonly destruction: Destruction;
  readonly nav: Nav;
  navBudget = 3;
  running = false;
  over = false;
  winner: Team | null = null;
  slowmo = 1;
  timeLeft = MATCH_TIME;
  private brainT = 0;
  private spotT = 0;
  private alertT = [0, 0];
  private rng = mulberry32(42);
  feed: FeedEntry[] = [];
  minimapDirty = true;
  readonly rocketGeo = boxes([
    [0.1, 0.1, 0.5, 0, 0, 0, 0x4d5a3a],
    [0.13, 0.13, 0.12, 0, 0, 0.27, 0xb0412e],
    [0.24, 0.02, 0.1, 0, 0, -0.22, 0x2a2d30],
    [0.02, 0.24, 0.1, 0, 0, -0.22, 0x2a2d30],
  ]);
  readonly grenadeGeo = boxes([
    [0.14, 0.14, 0.16, 0, 0, 0, 0x4a5a3a],
    [0.06, 0.05, 0.06, 0, 0.09, 0, 0x2a2d30],
  ]);
  readonly c4Geo = boxes([
    [0.26, 0.1, 0.18, 0, 0, 0, 0xb8a46a],
    [0.06, 0.04, 0.06, 0.06, 0.07, 0, 0xff3030],
  ]);

  constructor(
    readonly renderer: Renderer,
    readonly world: World,
    readonly info: MapInfo,
    readonly chunks: ChunkManager,
    readonly audio: Audio,
    readonly input: Input,
    readonly ev: GameEvents,
  ) {
    const scene = renderer.scene;
    renderer.viewmodel = this.viewmodel;
    this.particles = new Particles(renderer.fxScene);
    this.debris = new Debris(world, scene);
    this.nav = new Nav(world);
    this.destruction = new Destruction(world, scene, this.particles, this.debris, {
      onBarrel: (x, y, z, size) => this.explode(x, y, z, 3.6 + size * 0.05, 110, 2.2 + Math.min(1.2, size * 0.06), null, 'Fuel barrel'),
      onTopple: (x, y, z, tree) => this.audio.creak(new THREE.Vector3(x, y, z), tree),
      onBodyImpact: (x, y, z, size, minX, minZ, maxX, maxZ, tree) => {
        const p = new THREE.Vector3(x, y, z);
        this.audio.crash(p, size);
        this.addShake(p, Math.min(1.2, size / 500));
        // crush anyone underneath
        for (const s of this.soldiers) {
          if (!s.alive) continue;
          if (s.pos.x > minX - 0.4 && s.pos.x < maxX + 0.4 && s.pos.z > minZ - 0.4 && s.pos.z < maxZ + 0.4 && Math.abs(s.pos.y - y) < 4) {
            this.damageSoldier(s, tree ? 45 : 70, null, new THREE.Vector3(0, -1, 0), tree ? 'Falling tree' : 'Collapse');
          }
        }
        // splash if it fell into water
        if (y < WATER_Y + 1.5 && y > WATER_Y - 3) {
          this.particles.splash(x, WATER_Y, z, 24, 1.6);
          this.renderer.water?.addRipple(x, z, 2.2);
        }
      },
    });
    for (const team of [TEAM_BLUE, TEAM_RED] as Team[]) {
      const c = info.cores[team];
      const core = new Core(team, c.x, info.coreY[team], c.z);
      this.cores.push(core);
      scene.add(core.group);
    }
  }

  // --------------------------------------------------------------------------------- setup
  options: MatchOptions = { difficulty: 'regular', minutes: 15 };
  private coreScoreAcc = 0;
  private coreScoreT = 0;

  start(playerName: string, loadout: Loadout, options?: MatchOptions) {
    if (options) this.options = options;
    this.timeLeft = this.options.minutes * 60;
    const scene = this.renderer.scene;
    const names = [...BOT_NAMES].sort(() => this.rng() - 0.5);
    this.player = new Soldier(playerName, TEAM_BLUE, true, loadout);
    this.soldiers.push(this.player);
    const prefs = ['ar', 'dmr', 'lmg', 'smg', 'sniper', 'shotgun', 'minigun', 'ar', 'dmr'];
    for (let i = 0; i < 9; i++) {
      const team: Team = i < 4 ? TEAM_BLUE : TEAM_RED;
      const lo = randomLoadout(this.rng, prefs[i]);
      const s = new Soldier(names[i], team, false, lo);
      const b = new Bot(s, this, i * 13 + 5);
      b.skill = Math.min(1, Math.max(0.15, b.skill + DIFF_SKILL[this.options.difficulty]));
      // bots shoot looser than their weapon allows, less so the better they are
      s.spreadMul = 1.9 - b.skill * 0.9;
      this.soldiers.push(s);
      this.bots.push(b);
    }
    for (const s of this.soldiers) scene.add(s.rig.root);
    // initial roles
    this.assignRoles(true);
    // spawn everyone
    const idx = [0, 0];
    for (const s of this.soldiers) {
      const sp = this.info.spawns[s.team][idx[s.team]++ % 5];
      s.respawn(sp.x, this.world.floorAt(sp.x, sp.z), sp.z, 0);
    }
    for (const b of this.bots) b.onRespawn();
    this.pc = new PlayerController(this.player, this.input, this);
    this.viewmodel.setWeapon(this.player);
    this.running = true;
    this.ev.onMessage('Destroy the enemy core. Defend yours.', 'info');
  }

  private assignRoles(initial = false) {
    for (const team of [TEAM_BLUE, TEAM_RED] as Team[]) {
      const bots = this.bots.filter((b) => b.s.team === team);
      const core = this.cores[team];
      const enemyCore = this.cores[1 - team];
      const threatened = this.time - core.lastHit < 12 || [...this.intel[team].values()].some((k) => this.time - k.t < 5 && Math.hypot(k.x - core.pos.x, k.z - core.pos.z) < 32);
      let defenders = threatened ? 2 : 1;
      if (core.hp < 900) defenders++;
      if (enemyCore.hp < 700 && !threatened) defenders = Math.max(0, defenders - 1);
      if (team === TEAM_BLUE) defenders = Math.min(defenders, 2);
      // keep existing defenders when possible, otherwise pick bots nearest our core
      const sorted = [...bots].sort((a, b) => {
        const ad = a.role === 'defend' ? -1000 : 0, bd = b.role === 'defend' ? -1000 : 0;
        const da = Math.hypot(a.s.pos.x - core.pos.x, a.s.pos.z - core.pos.z) + ad;
        const db = Math.hypot(b.s.pos.x - core.pos.x, b.s.pos.z - core.pos.z) + bd;
        return da - db;
      });
      sorted.forEach((b, i) => {
        let role: Role = i < defenders ? 'defend' : 'attack';
        if (role === 'attack' && i === sorted.length - 1 && sorted.length - defenders >= 3) role = 'flank';
        if (b.role !== role || initial) {
          b.role = role;
          b.defendSpot = i * 3;
          if (role === 'attack') b.lane = initial ? i % 3 : b.lane;
          if (role === 'flank') b.lane = initial ? (i % 2 === 0 ? 0 : 2) : this.quietLane(team);
          if (!initial && b.s.alive) {
            b.state = role === 'defend' ? 'defend' : 'advance';
            b.path = null;
          }
        }
      });
    }
  }

  /** lane with the fewest recent enemy sightings */
  private quietLane(team: Team) {
    const lanes = this.info.lanes[team];
    let best = 0, bestN = 1e9;
    lanes.forEach((lane, li) => {
      const mid = lane[Math.floor(lane.length / 2)];
      let n = 0;
      for (const k of this.intel[team].values()) if (this.time - k.t < 15 && Math.hypot(k.x - mid.x, k.z - mid.z) < 30) n++;
      if (n < bestN) {
        bestN = n;
        best = li;
      }
    });
    return best;
  }

  coreApproach(team: Team, id: number) {
    // spots in front of / behind the bunker doors (bunker front faces the enemy)
    const c = this.cores[team].pos;
    const sgn = team === TEAM_BLUE ? -1 : 1; // front of blue bunker faces -z
    const pts = [
      { x: c.x + (id % 2 ? 1.2 : -1.2), z: c.z + sgn * 5.5 },
      { x: c.x + (id % 2 ? 0.8 : -0.8), z: c.z - sgn * 5.5 },
    ];
    return pts[id % 3 === 0 ? 1 : 0];
  }

  // --------------------------------------------------------------------------------- combat
  fireWeapon(s: Soldier, w: WeaponState) {
    const st = w.stats;
    const def = w.def;
    s.computeMuzzle();
    const m = s.muzzle;
    // muzzle inside a wall? fire from the chest instead
    if (this.world.solidAt(m.x, m.y, m.z)) m.set(s.pos.x, s.pos.y + 1.25, s.pos.z);
    this.audio.gunshot(m, def.sound, st.suppressed, s.isPlayer);
    this.noises.push({ x: m.x, z: m.z, t: this.time, team: s.team, radius: (st.suppressed ? 9 : 42) * st.loud });
    if (!st.suppressed) s.spottedUntil = Math.max(s.spottedUntil, this.time + 1.5);
    if (s.isPlayer) {
      // the viewmodel draws the flash; the world only gets its light
      this.viewmodel.onShot(s);
      this.pc.onShot();
      if (!st.suppressed) this.renderer.flashAt(m.x + s.aimDir.x * 0.8, m.y - 0.1, m.z + s.aimDir.z * 0.8, def.model.bulky ? 7 : 4.5, 0xffb060, 0.05);
      this.renderer.shake = Math.min(0.5, this.renderer.shake + st.recoil * (def.model.bulky ? 2 : 1.2));
    } else if (!st.suppressed) {
      this.particles.muzzle(m.x, m.y, m.z, s.aimDir.x, s.aimDir.z, def.model.bulky ? 1.4 : 1);
      if (Math.random() < 0.5) this.renderer.flashAt(m.x, m.y + 0.2, m.z, def.model.bulky ? 9 : 6, 0xffb060, 0.06);
    }
    const spread = s.spread() * s.spreadMul;
    s.pelletsFired += st.pellets;
    const right = tmpR.set(s.aimDir.z, 0, -s.aimDir.x);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = tmpU.crossVectors(right, s.aimDir).normalize();
    for (let i = 0; i < st.pellets; i++) {
      tmpD.copy(s.aimDir);
      // gaussian-ish cone around the aim
      const a = Math.random() * Math.PI * 2;
      const r = spread * Math.sqrt(Math.random());
      tmpD.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r);
      tmpD.normalize();
      const kind: ProjKind = st.projectile === 'rocket' ? 'rocket' : st.projectile === 'grenade' ? 'grenade' : 'bullet';
      // the player's rockets and grenades appear a little ahead of the eye
      const start = s.isPlayer && kind !== 'bullet' ? m.clone().addScaledVector(s.aimDir, 0.6).add(tmpV.set(0, -0.12, 0)) : m.clone();
      const p: Proj = {
        kind,
        pos: start,
        vel: tmpD.clone().multiplyScalar(st.velocity * (0.97 + Math.random() * 0.06)),
        owner: s,
        team: s.team,
        stats: st,
        dmg: st.damage,
        traveled: 0,
        life: kind === 'bullet' ? Math.min(1.2, (st.range * 3) / st.velocity + 0.2) : 6,
        fuse: kind === 'grenade' ? st.fuse : 0,
        mesh: null,
        stuck: false,
        dead: false,
        wet: false,
        trailT: 0,
        weaponName: def.name,
      };
      if (kind === 'grenade') p.vel.y += 6.5;
      if (kind !== 'bullet') {
        const mesh = new THREE.Mesh(kind === 'rocket' ? this.rocketGeo : this.grenadeGeo, toyMaterial);
        mesh.castShadow = true;
        mesh.position.copy(p.pos);
        this.renderer.scene.add(mesh);
        p.mesh = mesh;
        if (kind === 'rocket') this.renderer.flashAt(m.x, m.y, m.z, 14, 0xffa050, 0.2);
      }
      this.projectiles.push(p);
    }
  }

  useItem(s: Soldier) {
    if (s.item === 'c4' && s.c4.length > 0) {
      // detonate all placed charges
      for (const p of this.projectiles) if (p.kind === 'c4' && p.owner === s && !p.dead) p.fuse = 0.05;
      s.c4 = [];
      this.audio.beep(s.pos);
      return;
    }
    if (s.itemCount <= 0) return;
    if (s.item === 'medkit') {
      if (s.hp >= 100) return;
      s.itemCount--;
      s.healLeft = 70;
      this.audio.uiClick(1);
      this.particles.add.spawn({ x: s.pos.x, y: s.pos.y + 1.2, z: s.pos.z, vy: 1.2, size: 0.5, life: 0.8, r: 0.4, g: 3, b: 0.8 });
      return;
    }
    s.itemCount--;
    if (s.isPlayer) {
      // first person: lob along the view
      const f = this.pc.forward;
      const from = this.pc.eye.clone().addScaledVector(f, 0.45).add(new THREE.Vector3(0, -0.15, 0));
      const vel = f.clone().multiplyScalar(s.item === 'c4' ? 10 : 15).add(new THREE.Vector3(0, s.item === 'c4' ? 2.5 : 4.5, 0));
      vel.x += s.vel.x * 0.5;
      vel.z += s.vel.z * 0.5;
      this.throwItem(s, from, vel);
      return;
    }
    const from = new THREE.Vector3(s.pos.x, s.pos.y + 1.5, s.pos.z);
    const tgt = s.intent.aim;
    let dx = tgt.x - from.x, dz = tgt.z - from.z;
    let d = Math.hypot(dx, dz);
    const maxD = 24;
    if (d > maxD) {
      dx *= maxD / d;
      dz *= maxD / d;
      d = maxD;
    }
    if (d < 2) {
      dx = Math.sin(s.yaw) * 2;
      dz = Math.cos(s.yaw) * 2;
      d = 2;
    }
    const ty = this.world.groundBelow(from.x + dx, s.pos.y + 3, from.z + dz);
    const T = 0.45 + d / 18;
    const g = 18;
    const vel = new THREE.Vector3(dx / T, (ty - from.y + 0.5 * g * T * T) / T, dz / T);
    this.throwItem(s, from, vel);
  }

  private throwItem(s: Soldier, from: THREE.Vector3, vel: THREE.Vector3) {
    const kind: ProjKind = s.item === 'frag' ? 'frag' : s.item === 'smoke' ? 'smoke' : 'c4';
    const mesh = new THREE.Mesh(kind === 'c4' ? this.c4Geo : this.grenadeGeo, toyMaterial);
    mesh.castShadow = true;
    this.renderer.scene.add(mesh);
    const p: Proj = { kind, pos: from, vel, owner: s, team: s.team, stats: null, dmg: 0, traveled: 0, life: kind === 'c4' ? 240 : 8, fuse: kind === 'frag' ? 2.3 : kind === 'smoke' ? 1.4 : 1e9, mesh, stuck: false, dead: false, wet: false, trailT: 0, weaponName: kind === 'frag' ? 'Frag' : 'Demo Charge' };
    if (kind === 'c4') s.c4.push(mesh);
    this.projectiles.push(p);
    this.audio.throwSnd(s.pos);
  }

  private hitSoldierRay(p: Proj, dir: THREE.Vector3, len: number) {
    let best = len;
    let target: Soldier | null = null;
    let headshot = false;
    for (const s of this.soldiers) {
      if (!s.alive || s.team === p.team) continue;
      const ox = p.pos.x - s.pos.x, oz = p.pos.z - s.pos.z;
      const a = dir.x * dir.x + dir.z * dir.z;
      if (a < 1e-8) continue;
      const b = 2 * (ox * dir.x + oz * dir.z);
      const c = ox * ox + oz * oz - 0.4 * 0.4;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t < -0.3 || t > best) continue;
      const y = p.pos.y + dir.y * t;
      if (y < s.pos.y + 0.05 || y > s.pos.y + 1.85) continue;
      best = Math.max(0, t);
      target = s;
      headshot = y > s.pos.y + 1.42;
    }
    return { t: best, s: target, headshot };
  }

  private updateProjectiles(dt: number) {
    const world = this.world;
    for (const p of this.projectiles) {
      if (p.dead) continue;
      p.life -= dt;
      if (p.life <= 0) {
        if (p.kind === 'frag' || p.kind === 'grenade' || p.kind === 'rocket') this.detonate(p);
        else this.kill(p);
        continue;
      }
      if (p.kind === 'bullet') this.stepBullet(p, dt);
      else this.stepPhysical(p, dt);
    }
    this.projectiles = this.projectiles.filter((p) => !p.dead);
    void world;
  }

  private stepBullet(p: Proj, dt: number) {
    const st = p.stats!;
    const speed = p.vel.length();
    let len = speed * dt;
    const dir = tmpD.copy(p.vel).divideScalar(speed);
    // tracer visual
    const bright = st.tracer ? 2.2 : 1;
    const nearEye = p.owner.isPlayer && p.traveled < 3.5;
    if (!nearEye && Math.random() < (st.pellets > 1 ? 0.35 : 1)) this.particles.tracer(p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, bright, Math.min(0.05, dt * 1.2));
    // water entry
    if (!p.wet && p.pos.y > WATER_Y && p.pos.y + dir.y * len <= WATER_Y && dir.y < 0) {
      const t = (WATER_Y - p.pos.y) / dir.y;
      const wx = p.pos.x + dir.x * t, wz = p.pos.z + dir.z * t;
      const k = this.nav.cellOf(wx, wz);
      if (this.world.floorAt(wx, wz) < WATER_Y || this.nav.h[k] * VOXEL < WATER_Y) {
        this.particles.splash(wx, WATER_Y, wz, 6, 0.7);
        this.renderer.water?.addRipple(wx, wz, 0.8);
        p.wet = true;
      }
    }
    if (p.wet) p.vel.multiplyScalar(Math.exp(-dt * 25));
    let guard = 0;
    while (len > 0 && guard++ < 6) {
      const sh = this.hitSoldierRay(p, dir, len);
      let coreHit: Core | null = null;
      let coreT = sh.t;
      for (const c of this.cores) {
        if (c.team === p.team) continue;
        const t = c.intersect(p.pos.x, p.pos.y, p.pos.z, dir.x, dir.y, dir.z, coreT);
        if (t >= 0 && t < coreT) {
          coreT = t;
          coreHit = c;
        }
      }
      const maxT = Math.min(sh.t, coreT);
      const vox = this.world.raycast(p.pos.x, p.pos.y, p.pos.z, dir.x, dir.y, dir.z, maxT, hit);
      const falloff = p.traveled < st.range ? 1 : Math.max(0.4, 1 - (p.traveled - st.range) / (st.range * 1.5));
      if (vox && hit.dist <= maxT) {
        const m = hit.mat;
        const mk = MATS[m]?.kind ?? 'stone';
        const pt = tmpV.set(hit.px, hit.py, hit.pz);
        this.destruction.damageVoxel(hit.x, hit.y, hit.z, st.struct * falloff, dir);
        this.impactFx(pt, hit.nx, hit.ny, hit.nz, m, mk);
        if (st.explosive > 0) {
          this.explode(hit.px, hit.py, hit.pz, st.explosive, st.blastDamage, st.voxRadius, p.owner, p.weaponName);
          this.kill(p);
          return;
        }
        // foliage rarely stops a bullet; AP rounds punch through
        const passes = (mk === 'leaf' && Math.random() < (st.pierce ? 0.95 : 0.65)) || (st.pierce > 0 && (mk === 'soft' || mk === 'wood') && Math.random() < 0.35);
        if (passes) {
          const adv = hit.dist + 0.05;
          p.pos.addScaledVector(dir, adv);
          p.traveled += adv;
          len -= adv;
          continue;
        }
        this.kill(p);
        return;
      }
      if (sh.s && sh.t <= coreT) {
        let dmg = p.dmg * falloff * (sh.headshot ? 1.5 : 1);
        if (st.explosive > 0) {
          this.explode(p.pos.x + dir.x * sh.t, p.pos.y + dir.y * sh.t, p.pos.z + dir.z * sh.t, st.explosive, st.blastDamage, st.voxRadius, p.owner, p.weaponName);
        }
        const hp = new THREE.Vector3(p.pos.x + dir.x * sh.t, p.pos.y + dir.y * sh.t, p.pos.z + dir.z * sh.t);
        if (sh.s.alive && sh.s.team !== p.owner.team) p.owner.pelletsHit++;
        const killed = this.damageSoldier(sh.s, dmg, p.owner, dir, p.weaponName, sh.headshot, hp);
        if (st.tracer) sh.s.markedUntil = this.time + 5;
        if (p.owner.isPlayer) this.ev.onHitMarker(killed, sh.headshot);
        this.audio.flesh(hp);
        const tc = sh.s.team === 0 ? [0.3, 0.55, 1.4] : [1.4, 0.35, 0.25];
        for (let i = 0; i < 3; i++) this.particles.add.spawn({ x: hp.x, y: hp.y, z: hp.z, vx: dir.x * 3 + (Math.random() - 0.5) * 3, vy: Math.random() * 3, vz: dir.z * 3 + (Math.random() - 0.5) * 3, size: 0.07, life: 0.25, r: tc[0] * 3, g: tc[1] * 3, b: tc[2] * 3, gravity: 9, stretch: 0.02 });
        dmg = 0;
        this.kill(p);
        return;
      }
      if (coreHit) {
        const cp = tmpV.set(p.pos.x + dir.x * coreT, p.pos.y + dir.y * coreT, p.pos.z + dir.z * coreT);
        this.damageCore(coreHit, p.dmg * 0.55 * falloff, p.owner, cp);
        if (st.explosive > 0) this.explode(cp.x, cp.y, cp.z, st.explosive, st.blastDamage, st.voxRadius, p.owner, p.weaponName);
        this.particles.sparks(cp.x, cp.y, cp.z, -dir.x, 0.3, -dir.z, 5, 1.5);
        if (p.owner.isPlayer) this.ev.onHitMarker(false, false);
        this.kill(p);
        return;
      }
      p.pos.addScaledVector(dir, len);
      p.traveled += len;
      len = 0;
    }
    if (p.traveled > st.range * 3.5) this.kill(p);
  }

  private stepPhysical(p: Proj, dt: number) {
    const world = this.world;
    if (p.stuck) {
      p.fuse -= dt;
      if (p.kind === 'c4' && Math.floor(this.time * 2) !== Math.floor((this.time - dt) * 2)) {
        this.particles.add.spawn({ x: p.pos.x, y: p.pos.y + 0.1, z: p.pos.z, size: 0.18, life: 0.12, r: 4, g: 0.3, b: 0.2 });
      }
      if (p.fuse <= 0) this.detonate(p);
      // ground under it was blown away
      if (p.kind === 'c4' && !world.solidAt(p.pos.x, p.pos.y - 0.12, p.pos.z) && !world.solidAt(p.pos.x + 0.2, p.pos.y, p.pos.z) && !world.solidAt(p.pos.x - 0.2, p.pos.y, p.pos.z)) p.stuck = false;
      return;
    }
    const g = p.kind === 'rocket' ? 0 : 18;
    p.vel.y -= g * dt;
    if (p.kind === 'rocket') {
      p.vel.multiplyScalar(1 + dt * 0.6);
      p.trailT -= dt;
      if (p.trailT <= 0) {
        p.trailT = 0.015;
        this.particles.smoke(p.pos.x, p.pos.y, p.pos.z, 0.4, 0.75, 1.4);
        this.particles.fire(p.pos.x, p.pos.y, p.pos.z, 0.25);
      }
    }
    if (p.fuse > 0 && p.kind !== 'c4') p.fuse -= dt;
    const speed = p.vel.length();
    const len = speed * dt;
    const dir = tmpD.copy(p.vel).divideScalar(Math.max(speed, 1e-4));
    // soldiers / cores (impact weapons only)
    if (p.kind === 'rocket' || (p.kind === 'grenade' && p.fuse <= 0)) {
      const sh = this.hitSoldierRay(p, dir, len);
      if (sh.s) {
        p.pos.addScaledVector(dir, sh.t);
        this.detonate(p);
        return;
      }
      for (const c of this.cores) {
        if (c.team === p.team) continue;
        const t = c.intersect(p.pos.x, p.pos.y, p.pos.z, dir.x, dir.y, dir.z, len);
        if (t >= 0) {
          p.pos.addScaledVector(dir, t);
          this.detonate(p);
          return;
        }
      }
    }
    // water
    if (p.pos.y > WATER_Y && p.pos.y + p.vel.y * dt <= WATER_Y && world.floorAt(p.pos.x, p.pos.z) < WATER_Y) {
      this.particles.splash(p.pos.x, WATER_Y, p.pos.z, 10, 1);
      this.renderer.water?.addRipple(p.pos.x, p.pos.z, 1.2);
      this.audio.splash(p.pos, 0.6);
      if (p.kind === 'rocket') {
        p.pos.y = WATER_Y;
        this.detonate(p);
        return;
      }
      p.vel.multiplyScalar(0.3);
    }
    if (p.pos.y < WATER_Y) p.vel.multiplyScalar(Math.exp(-dt * 4));
    if (world.raycast(p.pos.x, p.pos.y, p.pos.z, dir.x, dir.y, dir.z, len, hit)) {
      const mk = MATS[hit.mat]?.kind;
      if (p.kind === 'rocket' || (p.kind === 'grenade' && p.fuse <= 0)) {
        // rockets fly through thin foliage occasionally
        if (mk === 'leaf' && p.kind === 'rocket' && Math.random() < 0.5) {
          this.destruction.damageVoxel(hit.x, hit.y, hit.z, 99, dir);
        } else {
          p.pos.set(hit.px - dir.x * 0.1, hit.py - dir.y * 0.1, hit.pz - dir.z * 0.1);
          this.detonate(p);
          return;
        }
      } else if (p.kind === 'c4') {
        p.pos.set(hit.px + hit.nx * 0.06, hit.py + hit.ny * 0.06, hit.pz + hit.nz * 0.06);
        p.stuck = true;
        p.vel.set(0, 0, 0);
        if (p.mesh) {
          p.mesh.position.copy(p.pos);
          p.mesh.lookAt(p.pos.x + hit.nx, p.pos.y + hit.ny, p.pos.z + hit.nz);
          p.mesh.rotateX(Math.PI / 2);
        }
        this.audio.beep(p.pos);
        return;
      } else {
        // bounce
        p.pos.set(hit.px + hit.nx * 0.08, hit.py + hit.ny * 0.08, hit.pz + hit.nz * 0.08);
        if (hit.nx) p.vel.x *= -0.4;
        if (hit.ny) p.vel.y *= -0.35;
        if (hit.nz) p.vel.z *= -0.4;
        p.vel.multiplyScalar(0.75);
        if (speed > 3) this.audio.impact(p.pos, 'metal');
        if (hit.ny > 0 && Math.abs(p.vel.y) < 1.2) {
          p.vel.y = 0;
          p.vel.x *= 0.8;
          p.vel.z *= 0.8;
        }
      }
    } else p.pos.addScaledVector(p.vel, dt);
    if (p.mesh) {
      p.mesh.position.copy(p.pos);
      if (p.kind === 'rocket') p.mesh.lookAt(p.pos.x + p.vel.x, p.pos.y + p.vel.y, p.pos.z + p.vel.z);
      else p.mesh.rotation.x += dt * speed * 2;
    }
    if (p.fuse <= 0 && p.kind !== 'grenade') {
      this.detonate(p);
      return;
    }
    if (p.kind === 'grenade' && p.stats && p.stats.fuse > 0 && p.fuse <= 0) {
      this.detonate(p);
      return;
    }
  }

  private kill(p: Proj) {
    p.dead = true;
    if (p.mesh) this.renderer.scene.remove(p.mesh);
  }

  private detonate(p: Proj) {
    if (p.dead) return;
    this.kill(p);
    if (p.kind === 'smoke') {
      this.smokes.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z, t: 0, life: 14, emit: 0 });
      this.audio.throwSnd(p.pos);
      return;
    }
    if (p.kind === 'frag') return this.explode(p.pos.x, p.pos.y + 0.2, p.pos.z, 4.4, 115, 1.9, p.owner, 'Frag');
    if (p.kind === 'c4') {
      p.owner.c4 = p.owner.c4.filter((m) => m !== p.mesh);
      return this.explode(p.pos.x, p.pos.y, p.pos.z, 5, 160, 3.1, p.owner, 'Demo Charge');
    }
    const st = p.stats!;
    this.explode(p.pos.x, p.pos.y, p.pos.z, st.explosive, st.blastDamage, st.voxRadius, p.owner, p.weaponName);
  }

  explode(x: number, y: number, z: number, radius: number, damage: number, voxR: number, owner: Soldier | null, weapon: string) {
    const pos = new THREE.Vector3(x, y, z);
    const big = radius > 2;
    if (voxR > 0) {
      const n = this.destruction.carve(x, y, z, voxR, big ? 110 : 20);
      if (owner) owner.voxelsDestroyed += n;
    }
    // soldiers
    for (const s of this.soldiers) {
      if (!s.alive) continue;
      const cx = s.pos.x, cy = s.pos.y + 0.9, cz = s.pos.z;
      const d = Math.hypot(cx - x, cy - y, cz - z);
      if (d > radius) continue;
      if (owner && s.team === owner.team && s !== owner) continue;
      let k = Math.pow(1 - d / radius, 0.8);
      if (!this.world.lineOfSight(x, y + 0.2, z, cx, cy, cz)) k *= 0.35;
      const dir = new THREE.Vector3(cx - x, 0, cz - z).normalize();
      const killed = this.damageSoldier(s, damage * k * (s === owner ? 0.5 : 1), owner, dir, weapon);
      s.vel.x += dir.x * 7 * k;
      s.vel.z += dir.z * 7 * k;
      s.vel.y += 4 * k;
      if (owner?.isPlayer && s !== owner) this.ev.onHitMarker(killed, false);
    }
    for (const c of this.cores) {
      if (owner && c.team === owner.team) continue;
      const d = Math.hypot(c.pos.x - x, c.pos.y + 1.6 - y, c.pos.z - z);
      if (d < radius * 1.35) this.damageCore(c, damage * 1.45 * Math.pow(1 - d / (radius * 1.35), 0.6), owner, pos);
    }
    // visuals
    const n = Math.round(6 + radius * 3);
    for (let i = 0; i < n; i++) this.particles.fire(x + (Math.random() - 0.5) * radius * 0.4, y + Math.random() * 0.4, z + (Math.random() - 0.5) * radius * 0.4, radius * 0.4);
    for (let i = 0; i < n * 0.7; i++) this.particles.smoke(x + (Math.random() - 0.5) * radius * 0.6, y + Math.random(), z + (Math.random() - 0.5) * radius * 0.6, radius * 0.55, 0.22 + Math.random() * 0.15, 3.5 + radius * 0.4);
    this.particles.sparks(x, y, z, 0, 1, 0, Math.round(radius * 5), 1.5);
    const gy = this.world.groundBelow(x, y + 0.5, z);
    if (y - gy < 1.5) this.particles.dust(x, gy + 0.1, z, 0.55, 0.47, 0.36, Math.round(radius * 3), radius * 0.6);
    this.renderer.flashAt(x, y + 1, z, 40 * radius, 0xffa050, 0.35);
    this.audio.explosion(pos, radius / 3.5);
    this.addShake(pos, radius / 3);
    if (Math.abs(y - WATER_Y) < 2 && this.world.floorAt(x, z) < WATER_Y) {
      this.particles.splash(x, WATER_Y, z, 30, 2.2);
      this.renderer.water?.addRipple(x, z, 3);
    }
    this.noises.push({ x, z, t: this.time, team: owner ? owner.team : 0, radius: 60 });
    this.nav.addDanger(x, z, 2, radius + 2);
    this.minimapDirty = true;
  }

  addShake(p: THREE.Vector3, amount: number) {
    const d = Math.hypot(p.x - this.pc.eye.x, p.z - this.pc.eye.z);
    this.renderer.shake = Math.min(1.4, this.renderer.shake + amount / (1 + (d * d) / 300));
    if (d < 6 && amount > 0.5) this.renderer.flash = Math.min(0.25, this.renderer.flash + 0.12 * amount);
  }

  private impactFx(pt: THREE.Vector3, nx: number, ny: number, nz: number, mat: number, kind: string) {
    const pal = shared.uPalette.value[mat];
    const r = pal ? pal.x : 0.5, g = pal ? pal.y : 0.5, b = pal ? pal.z : 0.5;
    if (kind === 'metal' || kind === 'stone' || kind === 'build') this.particles.sparks(pt.x, pt.y, pt.z, nx, ny, nz, 3, kind === 'metal' ? 1.3 : 0.7);
    this.particles.dust(pt.x, pt.y, pt.z, r * 1.2 + 0.1, g * 1.2 + 0.1, b * 1.2 + 0.1, 2, 0.5);
    this.audio.impact(pt, kind);
  }

  damageSoldier(s: Soldier, dmg: number, from: Soldier | null, dir: THREE.Vector3, weapon = '', head = false, at?: THREE.Vector3): boolean {
    if (!s.alive) return false;
    if (from && from !== s && from.team === s.team) return false;
    const hpBefore = s.hp;
    const killed = s.hurt(dmg, from, dir, this.time);
    const dealt = Math.min(hpBefore, dmg);
    if (from && from !== s) {
      from.damageDealt += dealt;
      s.damagers.set(from, this.time);
      if (from.isPlayer && dealt > 0) {
        const p = at ?? tmpV.set(s.pos.x, s.pos.y + 1.4, s.pos.z);
        this.ev.onDamage(p.x, p.y, p.z, dealt, head, killed);
      }
    }
    if (s.isPlayer && dmg > 0) {
      this.ev.onPlayerHurt(dir, dmg);
      this.renderer.hurt = Math.min(1, this.renderer.hurt + dmg / 60);
    }
    // bots react to being shot
    const bot = this.bots.find((b) => b.s === s);
    if (bot && from && from.team !== s.team) {
      bot.known.set(from.id, { s: from, x: from.pos.x, z: from.pos.z, t: this.time, visible: false });
      if (!bot.target) bot.target = bot.known.get(from.id)!;
    }
    if (killed) {
      s.respawnAt = this.time + RESPAWN_TIME;
      if (from && from !== s) this.creditKill(from, s, head);
      // everyone else who hurt the victim recently gets an assist
      for (const [att, t] of s.damagers) {
        if (att === from || att.team === s.team || this.time - t > 10) continue;
        att.assists++;
        att.score += 40;
        if (att.isPlayer) this.ev.onScore('Assist', 40);
      }
      s.damagers.clear();
      s.streak = 0;
      s.multi = 0;
      const e: FeedEntry = { t: this.time, killer: from ? from.name : weapon || 'World', killerTeam: from ? from.team : ((1 - s.team) as Team), victim: s.name, victimTeam: s.team, weapon: from ? weapon : '', special: head ? 'headshot' : undefined };
      if (from === s) e.killer = s.name;
      this.feed.push(e);
      this.ev.onKill(e);
      if (s.isPlayer) this.pc.spectate = from && from !== s ? from : null;
    }
    return killed;
  }

  private creditKill(k: Soldier, victim: Soldier, head: boolean) {
    k.kills++;
    k.streak++;
    k.bestStreak = Math.max(k.bestStreak, k.streak);
    k.multi = this.time - k.lastKillT < 4.5 ? k.multi + 1 : 1;
    k.lastKillT = this.time;
    let pts = 100;
    if (head) {
      k.headshots++;
      pts += 50;
    }
    k.score += pts;
    if (!k.isPlayer) return;
    this.ev.onScore(head ? `Headshot · ${victim.name}` : `Eliminated ${victim.name}`, pts);
    if (victim.streak >= 3) {
      k.score += 50;
      this.ev.onScore('Ended a streak', 50);
    }
    const multi = ['', '', 'Double kill', 'Triple kill', 'Quad kill'][Math.min(k.multi, 4)];
    if (k.multi >= 2) {
      const b = 50 * (k.multi - 1);
      k.score += b;
      this.ev.onScore(k.multi > 4 ? 'Rampage' : multi, b, true);
    }
    const streakName: Record<number, string> = { 5: 'Killing spree', 8: 'Rampaging', 12: 'Unstoppable', 16: 'Legendary' };
    if (streakName[k.streak]) {
      k.score += 100;
      this.ev.onScore(`${streakName[k.streak]} · ${k.streak} in a row`, 100, true);
    }
  }

  damageCore(c: Core, dmg: number, from: Soldier | null, at: THREE.Vector3) {
    if (!c.alive || this.over) return;
    if (from && from.team === c.team) return;
    if (from) {
      from.coreDamage += dmg;
      from.score += dmg * 0.5;
      if (from.isPlayer) this.coreScoreAcc += dmg * 0.5;
    }
    const destroyed = c.hit(dmg, this.time, from ? from.pos.x : at.x, from ? from.pos.z : at.z);
    if (c.team === TEAM_BLUE && this.time - this.alertT[0] > 8) {
      this.alertT[0] = this.time;
      this.ev.onMessage('Our core is under attack!', 'warn');
      this.audio.alarm();
    }
    if (c.team === TEAM_RED && this.time - this.alertT[1] > 10 && from?.team === TEAM_BLUE) {
      this.alertT[1] = this.time;
      this.ev.onMessage('Enemy core taking damage', 'good');
    }
    if (destroyed) this.coreDestroyed(c);
  }

  private coreDestroyed(c: Core) {
    const p = c.pos;
    this.explode(p.x, p.y + 1.6, p.z, 7, 200, 5.5, null, 'Core breach');
    setTimeout(() => this.explode(p.x + 2, p.y + 3, p.z - 1, 5, 0, 3.5, null, ''), 250);
    setTimeout(() => this.explode(p.x - 2, p.y + 2, p.z + 2, 5, 0, 3.5, null, ''), 520);
    for (let i = 0; i < 60; i++) {
      const col = new THREE.Color(c.team === 0 ? 0x3d8bff : 0xff4d3d);
      this.debris.spawn(p.x, p.y + 1.6, p.z, (Math.random() - 0.5) * 18, 6 + Math.random() * 12, (Math.random() - 0.5) * 18, 0.25, col.multiplyScalar(3), 7);
    }
    this.endMatch((1 - c.team) as Team);
  }

  endMatch(winner: Team) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    this.slowmo = 0.25;
    this.audio.fanfare(winner === TEAM_BLUE);
    setTimeout(() => this.ev.onEnd(winner), 2600);
  }

  popSoldier(s: Soldier) {
    const col = new THREE.Color(s.team === 0 ? 0x4a5a46 : 0x7a6a4a);
    const tc = new THREE.Color(s.team === 0 ? 0x3d7fe6 : 0xe0483a);
    for (let i = 0; i < 16; i++) {
      this.debris.spawn(s.pos.x + (Math.random() - 0.5) * 0.5, s.pos.y + 0.3 + Math.random() * 1.2, s.pos.z + (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4, 0.16 + Math.random() * 0.1, i % 4 === 0 ? tc : col, 3);
    }
    this.particles.dust(s.pos.x, s.pos.y + 0.3, s.pos.z, 0.7, 0.7, 0.68, 6, 1.2);
  }

  reportSighting(team: Team, e: Soldier) {
    this.intel[team].set(e.id, { s: e, x: e.pos.x, z: e.pos.z, t: this.time });
  }

  smokeBlocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    for (const s of this.smokes) {
      if (s.t < 0.8 || s.t > s.life - 1) continue;
      const r = 3.3;
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const L2 = dx * dx + dy * dy + dz * dz;
      const t = Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.y + 1 - ay) * dy + (s.z - az) * dz) / L2));
      const cx = ax + dx * t - s.x, cy = ay + dy * t - s.y - 1, cz = az + dz * t - s.z;
      if (cx * cx + cy * cy + cz * cz < r * r) return true;
    }
    return false;
  }

  /** whether a world point is currently hidden by the x-ray cutout (mirrors the shader) */
  isCutAway(x: number, y: number, z: number) {
    const cam = this.renderer.camera;
    const v = tmpV.set(x, y, z).project(cam);
    const sx = v.x * 0.5 + 0.5, sy = v.y * 0.5 + 0.5;
    const res = shared.uResolution.value;
    const asp = res.x / res.y;
    const viewZ = tmpV.set(x, y, z).applyMatrix4(cam.matrixWorldInverse).z * -1;
    for (const [c, h] of [[shared.uCutA.value, shared.uCutH.value.x], [shared.uCutB.value, shared.uCutH.value.y]] as const) {
      const d = Math.hypot((sx - c.x) * asp, sy - c.y) / Math.max(c.w, 1e-4);
      if (viewZ < c.z - 1.2 && y > h && d < 0.85) return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------------- frame
  update(rawDt: number) {
    const dt = Math.min(rawDt, 1 / 20) * this.slowmo;
    if (this.over) this.slowmo = Math.min(1, this.slowmo + rawDt * 0.25);
    this.time += dt;
    if (!this.over) this.timeLeft -= dt;
    if (this.timeLeft <= 0 && !this.over) {
      const a = this.cores[0].hp, b = this.cores[1].hp;
      this.endMatch(a >= b ? TEAM_BLUE : TEAM_RED);
    }
    this.navBudget = 3;

    // player input
    if (this.player.alive && !this.over) this.pc.update(dt);
    else {
      this.player.intent.fire = false;
      this.player.intent.moveX = this.player.intent.moveZ = 0;
    }
    for (const b of this.bots) {
      if (this.over) {
        b.s.intent.fire = false;
        b.s.intent.moveX = b.s.intent.moveZ = 0;
        continue;
      }
      b.update(dt);
    }
    for (const s of this.soldiers) s.update(this, dt);
    this.updateProjectiles(dt);
    this.updateSmoke(dt);
    this.destruction.update(dt);

    // keep systems in sync with world edits
    const cols = this.world.flushColumns();
    if (cols.length) {
      this.nav.updateColumns(cols);
      this.renderer.water?.refreshColumns(cols);
      this.chunks.markSky(cols);
      this.minimapDirty = true;
    }
    this.chunks.update(dt);
    this.particles.update(dt);
    this.debris.update(dt);
    for (const c of this.cores) c.update(dt, this.time);
    this.nav.decay(dt);

    // respawns
    for (const s of this.soldiers) {
      if (!s.alive && this.time >= s.respawnAt && !this.over) {
        const spawns = this.info.spawns[s.team];
        const sp = spawns[(Math.random() * spawns.length) | 0];
        s.respawn(sp.x + (Math.random() - 0.5), this.world.floorAt(sp.x, sp.z) + 0.05, sp.z + (Math.random() - 0.5), this.time);
        const b = this.bots.find((bb) => bb.s === s);
        if (b) {
          if (Math.random() < 0.35) s.applyLoadout(randomLoadout(this.rng));
          b.onRespawn();
        }
        if (s.isPlayer) {
          this.pc.spectate = null;
          this.pc.faceEnemyCore();
        }
      }
    }
    // team brains
    this.brainT -= dt;
    if (this.brainT <= 0) {
      this.brainT = 6;
      this.assignRoles();
    }
    // the player spots what they can see
    this.spotT -= dt;
    if (this.spotT <= 0 && this.player.alive) {
      this.spotT = 0.25;
      const p = this.player;
      for (const e of this.soldiers) {
        if (e.team === p.team || !e.alive) continue;
        if (Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) > 40) continue;
        if (this.world.lineOfSight(p.pos.x, p.eyeY, p.pos.z, e.pos.x, e.pos.y + CHEST_HEIGHT, e.pos.z)) this.reportSighting(p.team, e);
      }
    }
    this.noises = this.noises.filter((n) => this.time - n.t < 1);
    // core damage points arrive as one tally rather than a toast per bullet
    this.coreScoreT -= dt;
    if (this.coreScoreT <= 0 && this.coreScoreAcc >= 5) {
      this.ev.onScore('Core damage', Math.round(this.coreScoreAcc));
      this.coreScoreAcc = 0;
      this.coreScoreT = 0.8;
    }
    this.input.endFrame();
  }

  private updateSmoke(dt: number) {
    for (const s of this.smokes) {
      s.t += dt;
      s.emit -= dt;
      if (s.emit <= 0 && s.t < s.life - 2) {
        s.emit = 0.07;
        const a = Math.random() * 6.28, r = Math.random() * Math.min(3, s.t * 3);
        this.particles.alpha.spawn({
          x: s.x + Math.cos(a) * r, y: s.y + 0.3 + Math.random() * 1.5, z: s.z + Math.sin(a) * r,
          vx: Math.cos(a) * 0.4, vy: 0.25, vz: Math.sin(a) * 0.4,
          size: 1.8 + Math.random(), grow: 0.5, life: 4.5, r: 0.78, g: 0.8, b: 0.8, a: 0.7, drag: 0.6, fadeIn: 0.5, soft: 1.5, spin: (Math.random() - 0.5) * 0.3,
        });
      }
    }
    this.smokes = this.smokes.filter((s) => s.t < s.life);
  }

  private sunVis = 1;
  private sunT = 0;
  private vmLight: ViewLight = {
    sunView: new THREE.Vector3(),
    upView: new THREE.Vector3(),
    sunColor: new THREE.Color(),
    sunI: 1,
    sky: new THREE.Color(),
    ground: new THREE.Color(),
    hemiI: 1,
    sunVis: 1,
    skyVis: 1,
  };

  /** the camera / viewmodel / shadow / audio bookkeeping that follows a frame update */
  updateView(dt: number) {
    const r = this.renderer;
    const pc = this.pc;
    pc.updateCamera(dt);
    const cam = r.camera;
    cam.updateMatrixWorld();
    // first person needs no x-ray cutout: every chunk keeps the fast discard-free shader
    shared.uCutA.value.w = 0;
    shared.uCutB.value.w = 0;
    this.chunks.updateCutout(0, 0, 0, 0, 0, 0);
    this.chunks.cullGrass(cam.position.x, cam.position.z);
    // shadows cover the ground ahead of the view
    const fx = Math.sin(pc.yaw), fz = Math.cos(pc.yaw);
    const ahead = r.shadowExtent * 0.45;
    tmpV.set(cam.position.x + fx * ahead, cam.position.y - 1.5, cam.position.z + fz * ahead);
    r.updateShadowCamera(tmpV);
    r.focusTarget.copy(pc.aimPoint);
    r.hurt = Math.max(0, r.hurt - dt * 0.8);
    r.desat = this.player.alive ? Math.max(0, (35 - this.player.hp) / 35) * 0.6 : 0.7;

    // viewmodel: follows the current weapon, lit like the spot the player stands in
    const p = this.player;
    const vm = this.viewmodel;
    vm.visible = p.alive && !this.over;
    if (p.alive) {
      vm.setWeapon(p);
      this.sunT -= dt;
      if (this.sunT <= 0) {
        this.sunT = 0.1;
        const e = pc.eye;
        const lit = !this.world.raycast(e.x, e.y, e.z, r.sunDir.x, r.sunDir.y, r.sunDir.z, 60, hit);
        this.sunTarget = lit ? 1 : 0;
      }
      this.sunVis += (this.sunTarget - this.sunVis) * Math.min(1, dt * 6);
      const L = this.vmLight;
      const inv = tmpQ.copy(cam.quaternion).invert();
      L.sunView.copy(r.sunDir).applyQuaternion(inv);
      L.upView.set(0, 1, 0).applyQuaternion(inv);
      L.sunColor.copy(r.sun.color);
      L.sunI = r.sun.intensity;
      L.sky.copy(r.hemi.color);
      L.ground.copy(r.hemi.groundColor);
      L.hemiI = r.hemi.intensity;
      L.sunVis = this.sunVis;
      L.skyVis = this.chunks.skyAt(pc.eye.x, pc.eye.y, pc.eye.z);
      vm.update(dt, p, pc.lookYaw, pc.lookPitch, pc.adsTarget, L);
    }

    // audio listener at the eye, panning relative to the view
    this.audio.listener.copy(cam.position);
    this.audio.listenerYaw = pc.yaw;
    const lp = cam.position;
    const rz = this.info.riverZ(lp.x);
    const dRiver = Math.min(Math.abs(lp.z - rz), Math.hypot(lp.x - MAP_W / 2, lp.z - MAP_D / 2) - 8);
    this.audio.updateAmbience(dt, Math.max(0, dRiver), 0.5 + 0.5 * Math.sin(this.time * 0.1));
    void WEAPON;
  }
  private sunTarget = 1;
}
