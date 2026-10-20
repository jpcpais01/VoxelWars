import * as THREE from 'three';
import { TEAM_BLUE, TEAM_RED, Team } from '../core/config';
import { angleDiff } from '../core/noise';
import type { FeedEntry, Game, HostLink, Human, PlayerEvents, Proj } from '../game/Game';
import type { Soldier } from '../game/Soldier';
import { ITEMS, Loadout, WEAPON } from '../game/weapons';
import type { FallingBody } from '../world/destruction';
import { Link } from './link';
import { F_ADS, F_ALIVE, F_GROUND, F_LOUD, F_MARKED, F_RELOAD, F_SEEN, F_SPRINT, MAX_HUMANS, MSG_SNAP, PROTOCOL, PeerState, Writer, r3, readState, v3, writeBody, writeEdits } from './protocol';
import { Advertiser, LobbyInfo, LobbyPlayer, MatchSettings, RosterEntry, Session, Welcome, cleanName } from './session';

/** how far behind the newest report a peer's player is drawn on the host (smooths jitter) */
const REMOTE_DELAY = 0.1;
/** a peer silent this long (ms) has gone, even if its connection never said so */
const SILENT_MS = 8000;
/** a peer's shot is judged against targets at most this far in the past */
const MAX_REWIND = 0.35;

interface Member {
  peer: string;
  name: string;
  team: Team;
  loadout: Loadout;
  s: Soldier | null;
  inMatch: boolean;
  queue: unknown[];
  states: PeerState[];
  tell: PlayerEvents | null;
  seen: number;
}

export function loadoutOf(s: Soldier): Loadout {
  return {
    primary: { id: s.weapons[0].def.id, build: { ...s.weapons[0].build } },
    secondary: { id: s.weapons[1].def.id, build: { ...s.weapons[1].build } },
    item: s.item,
  };
}

/** a loadout from the network that this build can actually equip */
export function validLoadout(l: unknown): l is Loadout {
  const o = l as Loadout;
  if (!o || typeof o !== 'object' || !o.primary || !o.secondary) return false;
  if (!ITEMS.some((i) => i.id === o.item)) return false;
  for (const w of [o.primary, o.secondary]) {
    const def = WEAPON[w?.id];
    if (!def || !w.build || typeof w.build !== 'object') return false;
    for (const [slot, att] of Object.entries(w.build)) {
      const list = (def.slots as Record<string, string[]>)[slot];
      if (att !== undefined && att !== null && (!list || !list.includes(att as string))) return false;
    }
  }
  return true;
}

const vec = (a: unknown, out = new THREE.Vector3()) => {
  const v = a as number[];
  return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? out.set(v[0], v[1], v[2]) : null;
};

/**
 * The host runs the real match: bots, physics, hits, destruction and cores. Peers send what their own
 * player does; the host judges it and streams the result back (snapshots, events and voxel edits).
 */
export class HostSession implements Session, HostLink {
  readonly role = 'host';
  info: LobbyInfo;
  status = 'Room open';
  ping = 0;
  onChange = () => {};
  onClosed = (_reason: string) => {};
  game: Game | null = null;
  private members = new Map<string, Member>();
  private me: LobbyPlayer;
  private ad: Advertiser | null = null;
  private edits = new Map<number, number>();
  private pendIdx: number[] = [];
  private pendMat: number[] = [];
  private snapT = 0;
  private flushT = 0;
  private statT = 0;
  private w = new Writer();
  private nextBody = 1;
  private tmp = new THREE.Vector3();

  constructor(
    readonly link: Link,
    readonly code: string,
    name: string,
    settings: MatchSettings,
    isPublic: boolean,
  ) {
    this.me = { peer: link.self, name: cleanName(name), team: TEAM_BLUE, host: true };
    this.info = { code, phase: 'lobby', players: [this.me], settings, isPublic };
    if (isPublic) this.ad = new Advertiser(() => (this.humans < MAX_HUMANS ? { code, humans: this.humans, phase: this.info.phase, host: this.me.name, t: 0 } : null));
    link.onJoin = (peer) => link.send('lobby', this.lobby(), peer);
    link.onLeave = (peer) => this.drop(peer);
    link.onFast = (buf, from) => this.intake(buf, from);
    link.on('hello', (d, from) => this.hello(d, from));
    link.on('team', (d, from) => {
      const m = this.members.get(from);
      if (!m || m.inMatch || (d?.team !== 0 && d?.team !== 1)) return;
      if (this.count(d.team) < 5) m.team = d.team;
      this.broadcast();
    });
    link.on('lo', (d, from) => {
      const m = this.members.get(from);
      if (!m || !validLoadout(d?.loadout)) return;
      m.loadout = d.loadout;
      // a peer sends its kit as it respawns
      if (m.s && this.game) {
        m.s.applyLoadout(d.loadout);
        this.loadout(m.s);
      }
    });
    link.on('deploy', (_d, from) => this.deploy(from));
    link.on('ping', (d, from) => {
      const m = this.members.get(from);
      if (m) m.seen = performance.now();
      link.send('pong', { c: d?.c, t: this.game?.time ?? 0 }, from);
    });
    link.on('bye', (_d, from) => this.drop(from));
    link.on('fire', (d, from) => this.fire(d, from));
    link.on('toss', (d, from) => this.toss(d, from));
    link.on('det', (_d, from) => {
      const s = this.members.get(from)?.s;
      if (s?.alive && this.game) this.game.detonateCharges(s);
    });
    link.on('heal', (_d, from) => {
      const s = this.members.get(from)?.s;
      if (s?.alive && s.hp < 100) s.healLeft = 70;
    });
  }

  get self() {
    return this.link.self;
  }

  get humans() {
    return this.members.size + 1;
  }

  private count(team: Team) {
    let n = this.me.team === team ? 1 : 0;
    for (const m of this.members.values()) if (m.team === team) n++;
    return n;
  }

  private lobby(): LobbyInfo {
    this.info.players = [this.me, ...[...this.members.values()].map((m) => ({ peer: m.peer, name: m.name, team: m.team, host: false }))];
    return this.info;
  }

  private broadcast() {
    this.link.send('lobby', this.lobby());
    this.onChange();
  }

  private hello(d: { v?: number; name?: string; loadout?: unknown }, from: string) {
    if (d?.v !== PROTOCOL) {
      this.link.send('nope', { why: 'This room runs a different version of VoxelWars. Reload the page to update, then try again.' }, from);
      return;
    }
    let m = this.members.get(from);
    if (!m) {
      if (this.humans >= MAX_HUMANS) {
        this.link.send('nope', { why: 'That room is full (10 players).' }, from);
        return;
      }
      // names stay unique, so the kill feed and scoreboard read right
      const base = cleanName(d.name ?? '');
      const taken = new Set([this.me.name, ...[...this.members.values()].map((o) => o.name)]);
      let name = base;
      for (let k = 2; taken.has(name); k++) name = `${base} ${k}`;
      const team: Team = this.count(TEAM_RED) < this.count(TEAM_BLUE) ? TEAM_RED : TEAM_BLUE;
      m = { peer: from, name, team, loadout: validLoadout(d.loadout) ? d.loadout : this.fallbackLoadout(), s: null, inMatch: false, queue: [], states: [], tell: null, seen: performance.now() };
      this.members.set(from, m);
      this.game?.ev.onMessage(`${name} joined the room`, 'info');
    }
    this.broadcast();
  }

  private fallbackLoadout(): Loadout {
    return { primary: { id: 'ar', build: {} }, secondary: { id: 'pistol', build: {} }, item: 'frag' };
  }

  /** a peer dropped out (closed the tab, lost connection) */
  private drop(peer: string) {
    const m = this.members.get(peer);
    if (!m) return;
    this.members.delete(peer);
    const g = this.game;
    if (g && m.s) {
      const bot = g.dropHuman(m.s);
      this.queueAll(['leave', m.s.id]);
      if (bot) this.queueAll(['join', this.entry(bot, null)]);
      g.ev.onMessage(`${m.name} left · a bot takes over`, 'info');
      this.queueAll(['msg', `${m.name} left · a bot takes over`, 'info', 0]);
    }
    this.broadcast();
  }

  setTeam(team: Team) {
    if (this.info.phase !== 'lobby' || this.me.team === team || this.count(team) >= 5) return;
    this.me.team = team;
    this.broadcast();
  }

  setSettings(s: MatchSettings) {
    if (this.info.phase !== 'lobby') return;
    this.info.settings = s;
    this.broadcast();
  }

  setLoadout() {
    /* the host equips straight from the loadout editor */
  }

  get team() {
    return this.me.team;
  }

  get name() {
    return this.me.name;
  }

  /** the humans to put in the match besides the host */
  lobbyHumans(): Human[] {
    return [...this.members.values()].map((m) => ({ peer: m.peer, name: m.name, team: m.team, loadout: m.loadout }));
  }

  /** the host's match has started: wire it up and bring everyone in */
  begin(game: Game) {
    this.game = game;
    game.host = this;
    game.world.onEdit = (i, m, quiet) => {
      this.edits.set(i, m);
      this.pendIdx.push(quiet ? (i | 0x80000000) >>> 0 : i);
      this.pendMat.push(m);
    };
    game.destruction.onBodyAdd = (b) => this.bodyAdded(b);
    game.destruction.onBodyEnd = (b) => this.queueAll(['bend', b.nid]);
    this.info.phase = 'match';
    for (const m of this.members.values()) {
      m.seen = performance.now();
      m.s = game.soldiers.find((s) => s.peer === m.peer) ?? null;
      if (m.s) this.welcome(m);
    }
    this.broadcast();
  }

  /** a peer in the lobby while the match runs jumps in */
  private deploy(peer: string) {
    const m = this.members.get(peer);
    const g = this.game;
    if (!m || !g || m.inMatch || g.over) return;
    const { s, replaced } = g.addHuman({ peer, name: m.name, team: m.team, loadout: m.loadout });
    m.s = s;
    if (replaced) this.queueAll(['leave', replaced.id]);
    this.queueAll(['join', this.entry(s, null)]);
    this.queueAll(['msg', `${m.name} deployed`, 'info', 0]);
    g.ev.onMessage(`${m.name} deployed`, 'info');
    this.welcome(m);
  }

  private entry(s: Soldier, to: Member | null): RosterEntry {
    return { id: s.id, name: s.name, team: s.team, human: s.human, loadout: loadoutOf(s), you: !!to && to.s === s };
  }

  private welcome(m: Member) {
    const g = this.game!;
    const w: Welcome = {
      you: m.s!.id,
      roster: g.soldiers.map((s) => ({ ...this.entry(s, m), alive: s.alive, x: r3(s.pos.x), y: r3(s.pos.y), z: r3(s.pos.z), life: s.life })),
      settings: this.info.settings,
      time: g.time,
      timeLeft: g.timeLeft,
      cores: [g.cores[0].hp, g.cores[1].hp],
    };
    this.link.send('welcome', w, m.peer);
    // the valley as it stands: every voxel changed since it was generated
    const n = this.edits.size;
    const idx = new Uint32Array(n), mats = new Uint8Array(n);
    let k = 0;
    for (const [i, mat] of this.edits) {
      idx[k] = i | 0x80000000;
      mats[k++] = mat;
    }
    this.link.sendBin('voxall', writeEdits(idx, mats, n), m.peer);
    for (const b of g.destruction.flying) if (b.nid) this.link.sendBin('bsp', this.bodyBytes(b), m.peer);
    this.link.send('ready', {}, m.peer);
    m.inMatch = true;
    m.queue = [['st', this.stats()]];
  }

  // ------------------------------------------------------------------------------ HostLink
  private q(m: Member, ev: unknown[]) {
    if (m.inMatch) m.queue.push(ev);
  }

  private queueAll(ev: unknown[], except?: Member) {
    for (const m of this.members.values()) if (m !== except) this.q(m, ev);
  }

  tell(s: Soldier): PlayerEvents | null {
    const m = s.peer ? this.members.get(s.peer) : undefined;
    if (!m || !m.inMatch) return null;
    return (m.tell ??= {
      hitMarker: (kill, head) => this.q(m, ['hm', kill ? 1 : 0, head ? 1 : 0]),
      hurt: (dir, amount, killed, by) => this.q(m, ['hurt', ...v3(dir), r3(amount), killed ? 1 : 0, by?.id ?? 0, r3(m.s?.respawnAt ?? 0)]),
      score: (label, pts, big) => this.q(m, ['sc', label, pts, big ? 1 : 0]),
      damage: (x, y, z, v, head, killed) => this.q(m, ['dmg', r3(x), r3(y), r3(z), r3(v), head ? 1 : 0, killed ? 1 : 0]),
      push: (vx, vy, vz) => this.q(m, ['push', r3(vx), r3(vy), r3(vz)]),
    });
  }

  shot(s: Soldier, wi: number, seed: number, spread: number, m: THREE.Vector3, d: THREE.Vector3, fp: boolean, nids: number[], cid: number) {
    const ev = ['shot', s.id, wi, seed, Math.round(spread * 1e6) / 1e6, ...v3(m), Math.round(d.x * 1e5) / 1e5, Math.round(d.y * 1e5) / 1e5, Math.round(d.z * 1e5) / 1e5, fp ? 1 : 0, cid, nids];
    for (const mb of this.members.values()) {
      // the shooter already drew its own shot; it only needs the ids of any rockets in it
      if (mb.s === s) {
        if (nids.length) this.q(mb, ['nids', cid, nids]);
      } else this.q(mb, ev);
    }
  }

  thrown(p: Proj) {
    const ev = ['throw', p.owner.id, p.kind, ...v3(p.pos), ...v3(p.vel), p.nid, p.cid];
    for (const mb of this.members.values()) {
      if (mb.s === p.owner) this.q(mb, ['nids', p.cid, [p.nid]]);
      else this.q(mb, ev);
    }
  }

  projEnd(p: Proj) {
    this.queueAll(['pend', p.nid]);
  }

  boom(x: number, y: number, z: number, radius: number) {
    this.queueAll(['boom', r3(x), r3(y), r3(z), r3(radius)]);
  }

  smoke(x: number, y: number, z: number) {
    this.queueAll(['smoke', r3(x), r3(y), r3(z)]);
  }

  feed(e: FeedEntry) {
    this.queueAll(['kill', e]);
  }

  teamMessage(team: Team, text: string, kind: 'info' | 'warn' | 'good', alarm: boolean) {
    for (const m of this.members.values()) if (m.s?.team === team) this.q(m, ['msg', text, kind, alarm ? 1 : 0]);
  }

  spawned(s: Soldier) {
    this.queueAll(['spawn', s.id, r3(s.pos.x), r3(s.pos.y), r3(s.pos.z), s.life, loadoutOf(s)]);
  }

  loadout(s: Soldier) {
    this.queueAll(['lo', s.id, loadoutOf(s)]);
  }

  ended(winner: Team) {
    this.queueAll(['st', this.stats()]);
    this.queueAll(['end', winner]);
    this.flush();
  }

  creak(x: number, y: number, z: number, tree: boolean) {
    this.queueAll(['creak', r3(x), r3(y), r3(z), tree ? 1 : 0]);
  }

  crash(x: number, y: number, z: number, size: number, tree: boolean) {
    this.queueAll(['crash', r3(x), r3(y), r3(z), r3(size), tree ? 1 : 0]);
  }

  private bodyBytes(b: FallingBody) {
    return writeBody(this.w, { nid: b.nid, gen: b.gen, pos: b.pos, quat: b.quat, colorOffset: b.colorOffset, grid: b.grid, mats: b.mats });
  }

  private bodyAdded(b: FallingBody) {
    b.nid = this.nextBody++;
    const to = this.matchPeers();
    if (to.length) this.link.sendBin('bsp', this.bodyBytes(b), to);
  }

  private matchPeers() {
    const out: string[] = [];
    for (const m of this.members.values()) if (m.inMatch) out.push(m.peer);
    return out;
  }

  private stats() {
    return (this.game?.soldiers ?? []).map((s) => [s.id, s.kills, s.deaths, s.assists, Math.round(s.score), Math.round(s.coreDamage), s.headshots, s.bestStreak, s.streak, s.voxelsDestroyed, s.pelletsFired, s.pelletsHit]);
  }

  // ------------------------------------------------------------------------------ peers' actions
  private shooter(from: string) {
    const s = this.members.get(from)?.s;
    return s && s.alive && this.game && !this.game.over ? s : null;
  }

  private fire(d: { w?: number; s?: number; sp?: number; m?: unknown; d?: unknown; rt?: number; c?: number }, from: string) {
    const s = this.shooter(from);
    const g = this.game;
    if (!s || !g || !d) return;
    const wi = d.w === 1 ? 1 : 0;
    const m = vec(d.m);
    const dir = vec(d.d, new THREE.Vector3());
    if (!m || !dir || dir.lengthSq() < 0.5) return;
    // a shot has to leave from about where that player stands (by its latest report)
    const last = this.members.get(from)?.states.at(-1);
    const near = (x: number, y: number, z: number) => m.distanceTo(this.tmp.set(x, y + 1.5, z)) < 5;
    if (!near(s.pos.x, s.pos.y, s.pos.z) && !(last && near(last.x, last.y, last.z))) m.copy(this.tmp.set(s.pos.x, s.pos.y + 1.5, s.pos.z));
    if (s.current !== wi) s.switchWeapon(wi);
    const rewind = Math.max(0, Math.min(MAX_REWIND, g.time - (Number(d.rt) || g.time)));
    g.fireWeapon(s, s.weapons[wi], { seed: (Number(d.s) | 0) >>> 0, spread: Math.max(0, Math.min(0.5, Number(d.sp) || 0)), m, d: dir.normalize(), fp: true, rewind, cid: Number(d.c) | 0 });
  }

  private toss(d: { k?: string; f?: unknown; v?: unknown; c?: number }, from: string) {
    const s = this.shooter(from);
    if (!s || !d || !['frag', 'smoke', 'c4'].includes(d.k ?? '')) return;
    const f = vec(d.f), v = vec(d.v, new THREE.Vector3());
    if (!f || !v) return;
    if (f.distanceTo(this.tmp.set(s.pos.x, s.pos.y + 1.5, s.pos.z)) > 3) f.copy(this.tmp);
    if (v.length() > 30) v.setLength(30);
    this.game!.throwItem(s, f, v, d.k as 'frag' | 'smoke' | 'c4', { cid: Number(d.c) | 0, nid: 0 });
  }

  /** a peer's movement report */
  private intake(buf: ArrayBuffer, from: string) {
    const st = readState(buf);
    const m = this.members.get(from);
    const g = this.game;
    if (!st || !m?.s || !g) return;
    m.seen = performance.now();
    if (st.life !== (m.s.life & 255) || !m.s.alive) return;
    // stamped on arrival in wall time: whatever the peer's clock says, this is when we learned it
    const list = m.states;
    const now = performance.now() / 1000;
    st.t = now;
    if (list.length && st.t <= list[list.length - 1].t) st.t = list[list.length - 1].t + 1e-3;
    list.push(st);
    while (list.length > 3 && list[1].t < now - 1) list.shift();
  }

  // ------------------------------------------------------------------------------ frame
  /** before the match update: peers' players move to where they reported */
  pre(_dt: number) {
    const g = this.game;
    if (!g) return;
    const rt = performance.now() / 1000 - REMOTE_DELAY;
    for (const m of this.members.values()) {
      const s = m.s;
      const L = m.states;
      if (!s || !s.alive || !L.length) continue;
      if (L[0].life !== (s.life & 255)) {
        m.states = [];
        continue;
      }
      let a = L[0], b: PeerState | null = null;
      for (let i = 0; i < L.length; i++) {
        if (L[i].t <= rt) a = L[i];
        else {
          b = L[i];
          break;
        }
      }
      if (b && a.t <= rt) {
        const f = (rt - a.t) / Math.max(1e-4, b.t - a.t);
        s.pos.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
        s.vel.set(a.vx + (b.vx - a.vx) * f, a.vy + (b.vy - a.vy) * f, a.vz + (b.vz - a.vz) * f);
        s.yaw = a.yaw + angleDiff(a.yaw, b.yaw) * f;
      } else {
        const last = b ?? a;
        const ex = Math.max(0, Math.min(0.12, rt - last.t));
        s.pos.set(last.x + last.vx * ex, last.y, last.z + last.vz * ex);
        s.vel.set(last.vx, last.vy, last.vz);
        s.yaw = last.yaw;
      }
      const cur = a.t <= rt ? a : L[0];
      s.ads = (cur.flags & F_ADS) !== 0;
      s.sprinting = (cur.flags & F_SPRINT) !== 0;
      s.onGround = (cur.flags & F_GROUND) !== 0;
      if (cur.wi !== s.current && cur.wi < s.weapons.length) s.switchWeapon(cur.wi);
      s.weapon.reloadT = cur.flags & F_RELOAD ? 1 : 0;
      s.weapon.spin = cur.spin;
    }
  }

  /** after the match update: stream it out */
  post(dt: number) {
    const g = this.game;
    if (!g) return;
    const now = performance.now();
    for (const m of [...this.members.values()]) if (now - m.seen > SILENT_MS) this.drop(m.peer);
    this.statT += dt;
    if (this.statT >= 1) {
      this.statT = 0;
      this.queueAll(['st', this.stats()]);
    }
    this.flushT += dt;
    if (this.flushT >= 1 / 30) {
      this.flushT = 0;
      this.flush();
    }
    this.snapT += dt;
    if (this.snapT >= 1 / 20) {
      this.snapT = 0;
      this.snapshot();
    }
  }

  /** edits first, then the events that may refer to them */
  private flush() {
    const to = this.matchPeers();
    if (this.pendIdx.length) {
      if (to.length) this.link.sendBin('vox', writeEdits(this.pendIdx, this.pendMat, this.pendIdx.length), to);
      this.pendIdx = [];
      this.pendMat = [];
    }
    for (const m of this.members.values()) {
      if (!m.inMatch || !m.queue.length) continue;
      this.link.send('ev', m.queue, m.peer);
      m.queue = [];
    }
  }

  private snapshot() {
    const g = this.game!;
    const to = this.matchPeers();
    if (!to.length) return;
    const w = this.w.reset();
    w.u8(MSG_SNAP);
    w.f32(g.time);
    w.f32(g.timeLeft);
    w.f32(g.cores[0].hp);
    w.f32(g.cores[1].hp);
    w.u8(g.soldiers.length);
    for (const s of g.soldiers) {
      const intel = g.intel[1 - s.team].get(s.id);
      let f = 0;
      if (s.alive) f |= F_ALIVE;
      if (s.ads) f |= F_ADS;
      if (s.sprinting) f |= F_SPRINT;
      if (s.weapon.reloading) f |= F_RELOAD;
      if (s.onGround) f |= F_GROUND;
      if (s.markedUntil > g.time) f |= F_MARKED;
      if (s.spottedUntil > g.time) f |= F_LOUD;
      if (intel && g.time - intel.t < 3) f |= F_SEEN;
      w.u16(s.id);
      w.u8(f);
      w.f32(s.pos.x);
      w.f32(s.pos.y);
      w.f32(s.pos.z);
      w.i16(s.vel.x * 100);
      w.i16(s.vel.y * 100);
      w.i16(s.vel.z * 100);
      w.yaw(s.yaw);
      w.u8(Math.max(0, Math.min(255, Math.ceil(s.hp))));
      w.u8(Math.round(s.weapon.spin * 255));
      w.u8(s.current);
    }
    // falling pieces: the biggest ones if there are many (keeps a snapshot inside one packet)
    let fl = g.destruction.flying.filter((b) => b.nid);
    if (fl.length > 40) fl = [...fl].sort((a, b) => b.mats.length - a.mats.length).slice(0, 40);
    w.u8(fl.length);
    for (const b of fl) {
      w.u32(b.nid);
      w.f32(b.pos.x);
      w.f32(b.pos.y);
      w.f32(b.pos.z);
      w.i16(b.quat.x * 32767);
      w.i16(b.quat.y * 32767);
      w.i16(b.quat.z * 32767);
      w.i16(b.quat.w * 32767);
    }
    const buf = w.done();
    for (const p of to) this.link.sendFast(buf, p);
  }

  /** rematch: everyone reloads into this room's lobby */
  rematch() {
    this.link.send('rematch', {});
  }

  leave() {
    this.ad?.stop();
    this.ad = null;
    this.link.leave();
  }
}
