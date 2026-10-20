import * as THREE from 'three';
import { Team } from '../core/config';
import { angleDiff } from '../core/noise';
import type { ClientLink, FeedEntry, Game, ProjKind } from '../game/Game';
import type { Soldier } from '../game/Soldier';
import type { Loadout } from '../game/weapons';
import { loadoutOf, validLoadout } from './host';
import { Link } from './link';
import { F_ADS, F_ALIVE, F_GROUND, F_LOUD, F_MARKED, F_RELOAD, F_SEEN, F_SPRINT, PROTOCOL, Snapshot, Writer, readBody, readEdits, readSnapshot, v3, writeState } from './protocol';
import { LobbyInfo, Session, Welcome, cleanName } from './session';

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const vec = (a: number[], o = 0) => new THREE.Vector3(a[o], a[o + 1], a[o + 2]);

/**
 * A peer's end of an online match. Its own player moves and shoots here at once (prediction);
 * everyone else is drawn a moment in the past, smoothly between the host's snapshots.
 */
export class PeerSession implements Session, ClientLink {
  readonly role = 'peer';
  info: LobbyInfo | null = null;
  status = 'Connecting…';
  ping = 0;
  onChange = () => {};
  onClosed = (_reason: string) => {};
  /** the host let us into its match: build the world as it stands, then deploy */
  onWelcome: (w: Welcome) => void = () => {};
  onReady: () => void = () => {};
  onRematch: () => void = () => {};
  game: Game | null = null;
  host: string | null = null;
  private welcome: Welcome | null = null;
  private snaps: Snapshot[] = [];
  /** when (our clock, ms) the newest snapshot arrived */
  private snapAt = 0;
  /**
   * The host-time moment everyone else is drawn at. It runs at our frame rate, nudged faster or
   * slower to stay `delay` behind the snapshots, so it follows the host even when the host's own
   * clock runs slow (a struggling host steps time in capped increments).
   */
  private rt = 0;
  private rate = 1;
  private clockSet = false;
  private pingT = 0;
  private stateT = 0;
  private delay = 0.1;
  private w = new Writer();
  private loadoutKey = new Map<number, string>();
  private closed = false;
  private helloT = 0;
  private waitTimer = 0;
  private buffered: { kind: 'vox' | 'bsp'; buf: ArrayBuffer }[] = [];
  /** falling bodies the host already ended: a spawn that arrives late must not resurrect one */
  private ended = new Set<number>();
  /** when each falling body last showed up in a snapshot */
  private bodySeen = new Map<number, number>();

  constructor(
    readonly link: Link,
    readonly code: string,
    private name: string,
    private loadout: Loadout,
  ) {
    link.on('lobby', (info: LobbyInfo, from) => {
      if (!info || info.code !== code) return;
      if (this.host && this.host !== from) return;
      if (!this.host) {
        this.host = from;
        this.hello();
      }
      this.info = info;
      this.status = info.phase === 'match' ? 'Match in progress' : 'In the lobby';
      clearTimeout(this.waitTimer);
      this.onChange();
    });
    link.on('nope', (d, from) => {
      if (from === this.host || !this.host) this.close(String(d?.why ?? 'The host turned us away.'));
    });
    link.on('welcome', (w: Welcome, from) => {
      if (from !== this.host) return;
      this.welcome = w;
      this.rt = w.time - this.delay;
      this.onWelcome(w);
    });
    link.on('ready', (_d, from) => {
      if (from !== this.host) return;
      this.onReady();
    });
    link.on('rematch', (_d, from) => {
      if (from === this.host) this.onRematch();
    });
    link.on('pong', (d, from) => {
      if (from !== this.host || typeof d?.c !== 'number') return;
      const rtt = performance.now() - d.c;
      this.ping = Math.round(this.ping ? this.ping * 0.6 + rtt * 0.4 : rtt);
    });
    link.on('ev', (list: unknown[][], from) => {
      if (from !== this.host || !Array.isArray(list)) return;
      for (const e of list) if (Array.isArray(e)) this.event(e);
    });
    link.onBin('voxall', (buf, from) => {
      if (from !== this.host) return;
      if (!this.game) return void this.buffered.push({ kind: 'vox', buf });
      const { idx, mats } = readEdits(buf);
      this.game.destruction.applyRemote(idx, mats, false);
    });
    link.onBin('vox', (buf, from) => {
      if (from !== this.host) return;
      if (!this.game) return void this.buffered.push({ kind: 'vox', buf });
      const { idx, mats } = readEdits(buf);
      this.game.destruction.applyRemote(idx, mats, true);
    });
    link.onBin('bsp', (buf, from) => {
      if (from !== this.host) return;
      if (!this.game) return void this.buffered.push({ kind: 'bsp', buf });
      this.bodySpawn(buf);
    });
    link.onFast = (buf, from) => {
      if (from !== this.host) return;
      const s = readSnapshot(buf);
      if (!s) return;
      const L = this.snaps;
      if (L.length && s.t <= L[L.length - 1].t) return;
      L.push(s);
      this.snapAt = performance.now();
      for (const b of s.bodies) this.bodySeen.set(b.nid, this.snapAt);
      // a body the snapshots stopped mentioning has ended, even if its end event went missing
      if (s.bodies.length < 40 && this.game)
        for (const nid of this.game.destruction.puppets.keys()) if (this.snapAt - (this.bodySeen.get(nid) ?? 0) > 2500) this.endBody(nid);
      if (L.length > 30) L.shift();
    };
    link.onJoin = () => {
      if (this.host) return;
      this.status = 'Found players, waiting for the host…';
      this.onChange();
    };
    link.onLeave = (peer) => {
      if (peer === this.host) this.close('The host left, so the match is over.');
    };
    // nobody answering means nobody is hosting that code
    this.waitTimer = window.setTimeout(() => {
      if (!this.host) this.close(`No room ${code} found. Check the code, or the host may have closed it.`);
    }, 25000);
    this.status = 'Searching the network…';
  }

  get self() {
    return this.link.self;
  }

  private hello() {
    if (!this.host) return;
    this.link.send('hello', { v: PROTOCOL, name: cleanName(this.name), loadout: this.loadout }, this.host);
    // keep in touch (the host drops peers it stops hearing from) and measure the round trip
    const tick = () => {
      if (this.closed || !this.host) return;
      this.link.send('ping', { c: performance.now() }, this.host);
      this.pingT = window.setTimeout(tick, this.game ? 1000 : 2500);
    };
    tick();
  }

  private close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.waitTimer);
    clearTimeout(this.pingT);
    this.link.leave();
    this.onClosed(reason);
  }

  setTeam(team: Team) {
    if (this.host) this.link.send('team', { team }, this.host);
  }

  setLoadout(l: Loadout) {
    this.loadout = l;
    if (this.host && !this.game) this.link.send('lo', { loadout: l }, this.host);
  }

  /** jump into the running match */
  deploy() {
    if (this.host) this.link.send('deploy', {}, this.host);
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.waitTimer);
    clearTimeout(this.pingT);
    if (this.host) this.link.send('bye', {}, this.host);
    this.link.leave();
  }

  /** the client game exists now: wire it and catch up on what arrived meanwhile */
  begin(game: Game) {
    this.game = game;
    game.client = this;
    const w = this.welcome!;
    game.time = w.time;
    game.timeLeft = w.timeLeft;
    for (let i = 0; i < 2; i++) game.cores[i].hp = w.cores[i];
    for (const r of w.roster) {
      const s = game.soldiers.find((o) => o.id === r.id);
      this.loadoutKey.set(r.id, JSON.stringify(r.loadout));
      if (!s || !r.alive) continue;
      s.respawn(r.x, r.y, r.z, w.time);
      s.life = r.life;
      if (s === game.player) game.pc.faceEnemyCore();
    }
    for (const b of this.buffered) {
      if (b.kind === 'bsp') this.bodySpawn(b.buf);
      else {
        const { idx, mats } = readEdits(b.buf);
        game.destruction.applyRemote(idx, mats, false);
      }
    }
    this.buffered = [];
  }

  // ------------------------------------------------------------------------------ ClientLink
  fire(wi: number, seed: number, spread: number, m: THREE.Vector3, d: THREE.Vector3, cid: number) {
    if (!this.host) return;
    this.link.send('fire', { w: wi, s: seed, sp: spread, m: v3(m), d: [d.x, d.y, d.z], rt: this.renderTime, c: cid }, this.host);
  }

  toss(kind: ProjKind, from: THREE.Vector3, vel: THREE.Vector3, cid: number) {
    if (this.host) this.link.send('toss', { k: kind, f: v3(from), v: v3(vel), c: cid }, this.host);
  }

  detonate() {
    if (this.host) this.link.send('det', {}, this.host);
  }

  heal() {
    if (this.host) this.link.send('heal', {}, this.host);
  }

  // ------------------------------------------------------------------------------ clock
  /** our best guess at the host's clock right now */
  private get serverNow() {
    return this.rt + this.delay;
  }

  /** the host time everyone else is drawn at (a shot is judged against the world at this moment) */
  get renderTime() {
    return this.rt;
  }

  private tickClock(dt: number) {
    const newest = this.snaps[this.snaps.length - 1];
    if (!newest) return;
    // where the host is about now, by the newest snapshot and how long ago it came
    const target = newest.t + Math.min(0.1, (performance.now() - this.snapAt) / 1000) - this.delay;
    if (!this.clockSet) {
      this.rt = target;
      this.clockSet = true;
      return;
    }
    this.rt += dt * this.rate;
    const err = target - this.rt;
    if (Math.abs(err) > 0.5) {
      this.rt = target;
      this.rate = 1;
    } else this.rate = Math.max(0.7, Math.min(1.3, 1 + err * 2));
  }

  private byId(id: number): Soldier | null {
    return this.game?.soldiers.find((s) => s.id === id) ?? null;
  }

  // ------------------------------------------------------------------------------ events
  private event(e: unknown[]) {
    const g = this.game;
    if (!g) return;
    const n = e as number[];
    const p = g.player;
    switch (e[0]) {
      case 'shot': {
        const s = this.byId(n[1]);
        if (!s || s === p) return;
        const wi = n[2] === 1 ? 1 : 0;
        if (s.current !== wi) s.switchWeapon(wi);
        g.fireWeapon(s, s.weapons[wi], { seed: n[3], spread: n[4], m: vec(n, 5), d: vec(n, 8), fp: n[11] === 1, rewind: 0, cid: 0, nids: e[13] as number[] });
        break;
      }
      case 'nids':
        g.bindNids(n[1], e[2] as number[]);
        break;
      case 'throw': {
        const s = this.byId(n[1]);
        if (!s || s === p) return;
        g.throwItem(s, vec(n, 3), vec(n, 6), e[2] as ProjKind, { nid: n[9], cid: n[10] });
        break;
      }
      case 'pend':
        g.endProj(n[1]);
        break;
      case 'boom':
        g.explodeFx(n[1], n[2], n[3], n[4]);
        g.destruction.noteBlast(n[1], n[2], n[3], n[4]);
        break;
      case 'smoke':
        g.addSmoke(n[1], n[2], n[3]);
        break;
      case 'kill':
        g.addFeed(e[1] as FeedEntry);
        break;
      case 'msg':
        g.ev.onMessage(String(e[1]), e[2] as 'info' | 'warn' | 'good');
        if (n[3]) g.audio.alarm();
        break;
      case 'spawn': {
        const s = this.byId(n[1]);
        if (!s) return;
        if (s === p) {
          p.respawn(n[2], n[3], n[4], g.time);
          p.life = n[5];
          g.pc.spectate = null;
          g.pc.faceEnemyCore();
          // our kit may have changed while we were down: the host needs it for damage and looks
          if (this.host) this.link.send('lo', { loadout: loadoutOf(p) }, this.host);
          return;
        }
        this.setLoadout2(s, e[6]);
        s.respawn(n[2], n[3], n[4], g.time);
        s.life = n[5];
        break;
      }
      case 'lo': {
        const s = this.byId(n[1]);
        if (s && s !== p) this.setLoadout2(s, e[2]);
        break;
      }
      case 'join': {
        const r = e[1] as { id: number; name: string; team: Team; human: boolean; loadout: Loadout };
        if (!r || this.byId(r.id) || !validLoadout(r.loadout)) return;
        g.addPuppet({ ...r, you: false });
        this.loadoutKey.set(r.id, JSON.stringify(r.loadout));
        break;
      }
      case 'leave': {
        const s = this.byId(n[1]);
        if (s && s !== p) g.removeSoldier(s);
        break;
      }
      case 'hm':
        g.ev.onHitMarker(n[1] === 1, n[2] === 1);
        break;
      case 'hurt': {
        const by = this.byId(n[6]);
        p.lastHurt = g.time;
        p.lastAttacker = by;
        p.lastHurtDir.set(n[1], n[2], n[3]);
        if (n[5] && p.alive) {
          p.alive = false;
          p.hp = 0;
          p.deathT = 0;
          p.vel.set(0, 0, 0);
          p.respawnAt = n[7];
          p.healLeft = 0;
        }
        g.localHurt(tmpV.set(n[1], n[2], n[3]), n[4], n[5] === 1, by);
        break;
      }
      case 'sc':
        p.score += n[2];
        g.ev.onScore(String(e[1]), n[2], n[3] === 1);
        break;
      case 'dmg':
        g.ev.onDamage(n[1], n[2], n[3], n[4], n[5] === 1, n[6] === 1);
        break;
      case 'push':
        p.vel.x += n[1];
        p.vel.y += n[2];
        p.vel.z += n[3];
        break;
      case 'creak':
        g.audio.creak(vec(n, 1), n[4] === 1);
        break;
      case 'crash':
        g.crashFx(n[1], n[2], n[3], n[4], n[5] === 1);
        break;
      case 'bend':
        this.endBody(n[1]);
        break;
      case 'st':
        this.stats(e[1] as number[][]);
        break;
      case 'end': {
        for (const c of g.cores) if (c.hp <= 0 || !c.alive) g.coreBurst(c);
        g.endMatch(n[1] as Team);
        break;
      }
    }
  }

  private setLoadout2(s: Soldier, l: unknown) {
    if (!validLoadout(l)) return;
    const key = JSON.stringify(l);
    if (this.loadoutKey.get(s.id) === key) return;
    this.loadoutKey.set(s.id, key);
    s.applyLoadout(l);
  }

  private stats(rows: number[][]) {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const s = this.byId(r[0]);
      if (!s) continue;
      [, s.kills, s.deaths, s.assists, s.score, s.coreDamage, s.headshots, s.bestStreak, s.streak, s.voxelsDestroyed] = r;
      if (s !== this.game!.player) {
        s.pelletsFired = r[10];
        s.pelletsHit = r[11];
      } else s.pelletsHit = r[11];
    }
  }

  private bodySpawn(buf: ArrayBuffer) {
    const b = readBody(buf);
    if (this.ended.has(b.nid)) return;
    this.bodySeen.set(b.nid, performance.now());
    this.game!.destruction.addPuppet(b.nid, b.grid, b.mats, b.gen, b.colorOffset, b.pos, b.quat);
  }

  private endBody(nid: number) {
    this.game?.destruction.dropPuppet(nid);
    this.bodySeen.delete(nid);
    this.ended.add(nid);
    if (this.ended.size > 512) this.ended.delete(this.ended.values().next().value!);
  }

  // ------------------------------------------------------------------------------ frame
  /** before the match update: host clock, everyone else's poses, cores, the timer */
  pre(dt: number) {
    const g = this.game;
    if (!g) return;
    this.tickClock(dt);
    g.time = this.serverNow;
    const L = this.snaps;
    const newest = L[L.length - 1];
    if (!newest) return;
    const rt = this.renderTime;
    // bracketing snapshots
    let a = L[0], b: Snapshot | null = null;
    for (let i = 0; i < L.length; i++) {
      if (L[i].t <= rt) a = L[i];
      else {
        b = L[i];
        break;
      }
    }
    if (a.t > rt) b = null;
    const f = b ? (rt - a.t) / Math.max(1e-4, b.t - a.t) : 0;
    const ext = b ? 0 : Math.max(0, Math.min(0.15, rt - a.t));
    if (!g.over) g.timeLeft = newest.timeLeft - (this.serverNow - newest.t);
    for (let i = 0; i < 2; i++) {
      const c = g.cores[i];
      const hp = newest.cores[i];
      if (hp < c.hp - 0.01 && c.alive) c.hit(c.hp - hp, g.time, c.pos.x, c.pos.z);
      else c.hp = hp;
    }
    const p = g.player;
    for (const sa of a.soldiers) {
      const s = this.byId(sa.id);
      if (!s) continue;
      if (s === p) {
        // our own player: the host only decides health (and, by event, death and respawn)
        const mine = newest.soldiers.find((o) => o.id === sa.id);
        if (mine && p.alive && mine.flags & F_ALIVE) p.hp = mine.hp;
        continue;
      }
      const sb = b?.soldiers.find((o) => o.id === sa.id);
      const alive = (sa.flags & F_ALIVE) !== 0;
      if (alive && !s.alive) s.respawn(sa.x, sa.y, sa.z, g.time);
      else if (!alive && s.alive) {
        s.alive = false;
        s.deathT = 0;
        s.hp = 0;
      }
      if (!alive) continue;
      if (sb && sb.flags & F_ALIVE) {
        s.pos.set(sa.x + (sb.x - sa.x) * f, sa.y + (sb.y - sa.y) * f, sa.z + (sb.z - sa.z) * f);
        s.vel.set(sa.vx + (sb.vx - sa.vx) * f, sa.vy + (sb.vy - sa.vy) * f, sa.vz + (sb.vz - sa.vz) * f);
        s.yaw = sa.yaw + angleDiff(sa.yaw, sb.yaw) * f;
      } else {
        s.pos.set(sa.x + sa.vx * ext, sa.y, sa.z + sa.vz * ext);
        s.vel.set(sa.vx, sa.vy, sa.vz);
        s.yaw = sa.yaw;
      }
      s.hp = sa.hp;
      s.ads = (sa.flags & F_ADS) !== 0;
      s.sprinting = (sa.flags & F_SPRINT) !== 0;
      s.onGround = (sa.flags & F_GROUND) !== 0;
      if (sa.wi !== s.current && sa.wi < s.weapons.length) s.switchWeapon(sa.wi);
      s.weapon.reloadT = sa.flags & F_RELOAD ? 1 : 0;
      s.weapon.spin = sa.spin;
      if (sa.flags & F_MARKED) s.markedUntil = g.time + 0.3;
      if (sa.flags & F_LOUD) s.spottedUntil = g.time + 0.3;
      if (sa.flags & F_SEEN) {
        const known = g.intel[1 - s.team].get(s.id);
        if (!known || g.time - known.t > 1) g.intel[1 - s.team].set(s.id, { s, x: s.pos.x, z: s.pos.z, t: g.time - 1 });
      }
    }
    // falling pieces
    for (const ba of a.bodies) {
      const body = g.destruction.puppets.get(ba.nid);
      if (!body) continue;
      const bb = b?.bodies.find((o) => o.nid === ba.nid);
      if (bb) {
        body.pos.lerpVectors(ba.pos, bb.pos, f);
        body.quat.slerpQuaternions(ba.quat, bb.quat, f);
      } else {
        body.pos.copy(ba.pos);
        body.quat.copy(ba.quat);
      }
      body.syncMesh();
    }
    void tmpQ;
  }

  /** after the match update: report our own player */
  post(dt: number) {
    const g = this.game;
    if (!g || !this.host) return;
    this.stateT += dt;
    if (this.stateT < 1 / 30) return;
    this.stateT = 0;
    const p = g.player;
    if (!p.alive) return;
    let flags = 0;
    if (p.ads) flags |= F_ADS;
    if (p.sprinting) flags |= F_SPRINT;
    if (p.weapon.reloading) flags |= F_RELOAD;
    if (p.onGround) flags |= F_GROUND;
    const buf = writeState(this.w, { t: this.serverNow, life: p.life, x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: p.vel.x, vy: p.vel.y, vz: p.vel.z, yaw: p.yaw, flags, wi: p.current, spin: p.weapon.spin });
    this.link.sendFast(buf, this.host);
  }
}
